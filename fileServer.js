const net = require('net');
const fs = require('fs');
const path = require('path');

class Client {
  constructor(...p) {
    [this.socket] = p;

    this.lineBuf = "";
    this.pasvSockets = [];
    this.pasvListeners = [];
    this.isPASV = false;
    this.pwd = "/";
    this.userRoot = __dirname;

    this.socket.on('connect', () => this.onConnect());
    this.socket.on('data', (s) => this.onData(s));
    this.socket.on('end', () => this.onEnd());
    this.socket.on('error', (err) => this.onError(err));
  }


  async getPASVPort() {
    if (this.pasvListeners.length > 0) return this.pasvListeners[0].address().port;

    const server = net.createServer((s) => {
      this.pasvSockets.push(s);
    });
    this.pasvListeners.push(server);
    return await new Promise((resolve) => server.listen(0, resolve)).then(() => server.address().port);
  }

  async getDataSocket() {
    if (this.isPASV) {
      let pasvSocket = this.pasvSockets.find(s => s.writable);
      if (!pasvSocket) {
        this.resp(550, 'No passive connections');
      } else {
        return pasvSocket;
      }
    } else {
      if (!this.activePort || this.activeIP) {
        this.resp(550, 'No active ports specified');
      } else {
        const con = net.createConnection({ host: this.activeIP, port: this.activePort[0] });
        await new Promise((resolve) => con.on('connect', resolve));
        return con;
      }
    }
  }

  async streamFile(path) {
    const socket = await this.getDataSocket();
    if (socket === undefined) return;
    let stat = await this.getStat(path);
    if (!stat) {
      this.resp(550, "File not accessible");
    } else {
      let [err, buf] = await new Promise((resolve) => fs.readFile(path, (...p) => resolve(p)));
      this.resp(150, 'Opening connection');
      await new Promise((resolve) => socket.write(buf, resolve));
      this.resp(226, 'DONE');
    }
    socket.end();
  }

  async streamDir(userPath) {
    const socket = await this.getDataSocket();
    if (socket === undefined) return;
    this.resp(150, 'Opening connection');
    const [err, files] = await new Promise((resolve) => fs.readdir(userPath, (...p) => resolve(p)));
    const stats = await Promise.all(files.map((fn) => new Promise(resolve => fs.stat(`${userPath}/${fn}`, (err, stat) => resolve([err, stat, fn])))));
    stats.forEach((p) => {
      const [err, stat, fn] = p;
      if (!stat) {
        console.log(`* STAT FAILED. ${err}`);
        return;
      }
      stat.perm = parseInt(stat.mode.toString(8), 10);
      stat.mtimeFmt = (new Date(stat.mtime)).toLocaleDateString('en-US', {month: 'short', year: 'numeric', day: '2-digit'}).split(',').join('');
      socket.write(`---------- ${stat.nlink} ${stat.uid} ${stat.gid} ${stat.size} ${stat.mtimeFmt} ${fn}${stat.isDirectory() ? '/' : ''}\r\n`);
    });
    this.resp(226, 'DONE');
    socket.end();
  }

  async getStat(userPath) {
    const [err, stat] = await new Promise((resolve) => fs.stat(userPath, (...p) => resolve(p)));
    if (err !== null) {
      console.log(`* STAT FAILED. ${err}`);
    }
    return stat;
  }

  onConnect() {

  }

  getAbsolutePath(userPath) {
    return path.join(this.userRoot, this.getRelativePath(userPath));
  }

  getRelativePath(userPath) {
    return path.normalize(path.join(this.pwd, userPath));
  }

  onData(buf) {
    const data = buf.toString('ascii');
    if (data.includes('\r\n')) {
      let lines = data.split('\r\n');
      lines.pop();
      lines[0] = this.lineBuf + lines[0];
      this.lineBuf = "";
      lines.forEach((l) => {
        l = l.trimLeft();
        let i = l.match(/(?:\s|$)/).index;
        this.command(l.substring(0, i), l.substring(i + 1));
      });
    } else {
      this.lineBuf += data;
    }
  }

  onEnd() {

  }

  onError(err) {

  }

  command(cmd, argStr) {
    console.log(`< ${cmd} ${argStr}`);
    if (cmd === 'PORT' && argStr.trim().length > 0 && !this.isPASV) {
      this.activePort = ((p1, p2) => Number(p1) * 256 + Number(p2))(...argStr.split(',').slice(4));
      this.activeIP = argStr.split(',').slice(0, 4).join('.');
      this.resp(200, 'Ports set');
    } else if (cmd === 'PASV' && argStr.trim().length === 0) {
      this.getPASVPort().then((port) => {
        this.isPASV = true;
        let parts = Client.addressToParts(this.socket.address().address, port);
        this.resp(227, `Passive mode ${port} (${parts.join(',')})`);
      }).catch(() => {
        this.resp(550, "Failed to change to passive mode");
      });
    } else if (cmd === 'USER' && argStr.trim().length > 0) {
      this.user = argStr;
      this.resp(230, 'User okay. Logged in.');
    } else if (cmd === 'PWD' && argStr.trim().length === 0) {
      this.resp(257, this.pwd);
    } else if (cmd === 'CWD') {
      const userPath = this.getAbsolutePath(argStr);
      this.getStat(userPath).then((stat) => {
        if (stat && stat.isDirectory()) {
          this.pwd = this.getRelativePath(argStr);
          this.resp(200, 'CWD Okay');
        } else {
          this.resp(550, 'Not a directory');
        }
      });
    } else if (cmd === 'TYPE' && argStr.trim().length > 0) {
      this.resp(200, 'Binary mode');
    } else if (cmd === 'SIZE' && argStr.trim().length > 0) {
      const userPath = this.getAbsolutePath(argStr);
      this.getStat(userPath).then((stat) => {
        if (stat) {
          this.resp(213, stat.size);
        } else {
          this.resp(550, "File not found");
        }
      });
    } else if (cmd === 'RETR' && argStr.trim().length > 0 && this.isAuthed() && this.isPASV) {
      this.streamFile(this.getAbsolutePath(argStr));
    } else if (cmd === 'LIST') {
      this.streamDir(this.getAbsolutePath(argStr));
    } else if (cmd === 'QUIT' && argStr.trim().length === 0) {
      this.end();
    } else {
      this.resp(502, 'Command not implemented');
    }
  }

  isAuthed() {
    return this.user !== undefined;
  }

  resp(code, msg) {
    console.log('>', code, msg);
    this.socket.write(`${code} ${msg}\r\n`);
  }

  start() {
    this.resp(220, 'Ready');
  }

  end() {
    this.resp(200, 'BYE');
    this.pasvListeners.forEach(s => s.close(() => s.unref()));
    this.socket.end();
  }

  static addressToParts(ip, port) {
    ip = ip.match(/\d+\.\d+\.\d+\.\d+/)[0];
    return [...ip.split('.'), (port & 0xFF00) >> 8, (port & 0x00FF)];
  }
}

if (process.argv.length !== 3 || isNaN(process.argv[2])) {
  process.stdout.write(`${process.argv[1]} <port>\n`);
  process.exit(1);
}

const port = Number(process.argv[2]);
const server = net.createServer((con) => (new Client(con)).start());
console.log(`Trying to start on port ${port}...`);
server.listen(port, '0.0.0.0');

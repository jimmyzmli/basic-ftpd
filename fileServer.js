const net = require('net');
const fs = require('fs');

class Client {
  constructor(...p) {
    [this.socket] = p;

    this.lineBuf = "";
    this.pasvSockets = [];
    this.pasvListeners = [];
    this.isPASV = false;

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
    path = `./${path}`;
    let [err, stat] = await new Promise((resolve) => fs.stat(path, (...p) => resolve(p)));
    if (err !== null) {
      this.resp(550, "File not accessible");
    } else {
      let [err, buf] = await new Promise((resolve) => fs.readFile(path, (...p) => resolve(p)));
      this.resp(150, 'Opening connection');
      await new Promise((resolve) => socket.write(buf, resolve));
      this.resp(226, 'DONE');
      socket.end();
    }
  }

  async streamDir(path) {
    const socket = await this.getDataSocket();
    this.resp(150, 'Opening connection');
    const [err, files] = await new Promise((resolve) => fs.readdir(path, (...p) => resolve(p)));
    console.log(files);
    files.forEach((fn) => socket.write(`${fn}\r\n`));
    this.resp(226, 'DONE');
    socket.end();
  }

  async getStat(path) {
    const [err, stat] = await new Promise((resolve) => fs.stat(path, (...p) => resolve(p)));
    if (err === null) {
      return stat;
    } else {
      this.resp(550, "File not accessible");
    }
  }

  onConnect() {

  }

  onData(buf) {
    const data = buf.toString('ascii');
    if (data.includes('\r\n')) {
      let lines = data.split('\r\n');
      lines.pop();
      lines[0] = this.lineBuf + lines[0];
      this.lineBuf = "";
      lines.forEach((l) => this.parse(l));
    } else {
      this.lineBuf += data;
    }
  }

  onEnd() {

  }

  onError(err) {

  }

  parse(l) {
    console.log('<', l);
    const regex = /(?:\s*)([^\s]+)/gi;
    const parts = [];
    let match;
    while ((match = regex.exec(l)) !== null) {
      parts.push(match[1]);
    }

    if (parts.length > 0) {
      this.command(parts);
    }
  }

  command(parts) {
    const [cmd, ...args] = parts;
    if (cmd === 'PORT' && args.length === 1 && !this.isPASV) {
      this.activePort = ((p1, p2) => Number(p1) * 256 + Number(p2))(...args[0].split(',').slice(4));
      this.activeIP = args[0].split(',').slice(0, 4).join('.');
      this.resp(200, 'Ports set');
    } else if (cmd === 'PASV' && args.length === 0) {
      this.getPASVPort().then((port) => {
        this.isPASV = true;
        let parts = Client.addressToParts(this.socket.address().address, port);
        this.resp(227, `Passive mode ${port} (${parts.join(',')})`);
      });
    } else if (cmd === 'USER' && args.length === 1) {
      this.user = args[0];
      this.resp(230, 'User okay. Logged in.');
    } else if (cmd === 'PWD' && args.length === 0) {
      this.resp(257, `"/"`);
    } else if (cmd === 'CWD' && args.length === 1) {
      this.getStat(args[0]).then((stat) => {
        if (stat.isDirectory()) {
          this.resp(200, 'CWD Okay');
        } else {
          this.resp(550, 'Not a directory');
        }
      });
    } else if (cmd === 'TYPE' && args.length === 1) {
      this.resp(200, 'Binary mode');
    } else if (cmd === 'SIZE' && args.length === 1) {
      this.getStat(args[0]).then((stat) => {
        this.resp(213, stat.size);
      });
    } else if (cmd === 'RETR' && args.length === 1 && this.isAuthed() && this.isPASV) {
      this.streamFile(args[0]);
    } else if (cmd === 'LIST') {
      this.streamDir('.');
    } else if (cmd === 'QUIT' && args.length === 0) {
      this.resp(200, 'BYE');
      this.socket.end();
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
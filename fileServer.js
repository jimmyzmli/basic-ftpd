const net = require('net');
const fs = require('fs');

// Promisify net
// net.Server.createServerPromise = function(opts) {
//   return new Promise(resolve => this.createServer(opts, resolve));
// };
// net.Socket.onPromise = function(evt) {
//   return new Promise(resolve => this.on(evt, resolve));
// };

// net.createConnectionPromise()
//   .then(con => con.onPromise('data'));

class Client {
  constructor(...p) {
    [this.socket] = p;

    this.lineBuf = "";
    this.pasvSockets = [];
    this.isPASV = false;

    this.socket.on('connect', () => this.onConnect());
    this.socket.on('data', (s) => this.onData(s));
    this.socket.on('end', () => this.onEnd());
    this.socket.on('error', (err) => this.onError(err));
  }


  async getNewPASV() {
    const server = net.createServer((s) => {
      this.pasvSockets.push(s);
    });
    this.pasvSockets.push(server);
    return await new Promise((resolve) => server.listen(0, resolve)).then(() => server.address().port);
  }

  async getFilePASV(fn) {
    let pasvSocket = this.pasvSockets.find(s => s.writable);
    if (!pasvSocket) {
      this.resp(550, 'No passive connections');
    } else {
      let [err, stat] = await new Promise((resolve) => fs.stat(fn, (...p) => resolve(p)));
      if (err !== null) {
        this.resp(550, "File not accessible");
      } else {
        let [err, buf] = await new Promise((resolve) => fs.readFile(fn, (...p) => resolve(p)));
        this.resp(150, 'Opening connection');
        await new Promise((resolve) => pasvSocket.write(buf, resolve));
        this.resp(226, 'DONE');
        pasvSocket.end();
      }
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
    if (cmd === 'USER' && args.length === 1) {
      this.user = args[0];
      this.resp(230, 'User okay. Logged in.');
    } else if (cmd === 'PWD' && args.length === 0) {
      this.resp(257, `"/"`);
    } else if (cmd === 'EPSV' && args.length === 0) {
      this.getNewPASV().then((port) => {
        this.isPASV = true;
        this.resp(229, `(|||${port}|)`);
      });
    } else if (cmd === 'TYPE' && args.length === 1) {
      this.resp(200, 'Binary mode');
    } else if (cmd === 'SIZE' && args.length === 1) {
      fs.stat(args[0], (err, stat) => {
        if (err === null) this.resp(213, stat.size);
        else this.resp(550, "File not accessible");
      });
    } else if (cmd === 'RETR' && args.length === 1 && this.isAuthed() && this.isPASV) {
      this.getFilePASV(args[0]);
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
}

if (process.argv.length !== 3 || isNaN(process.argv[2])) {
  process.stdout.write(`${process.argv[1]} <port>\n`);
  process.exit(1);
}

const port = Number(process.argv[2]);
const server = net.createServer((con) => (new Client(con)).start());
console.log(`Trying to start on port ${port}`);
server.listen(port);
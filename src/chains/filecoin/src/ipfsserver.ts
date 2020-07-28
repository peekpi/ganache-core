import path from "path";
import fs from "fs";
import os from "os";

const JsIpfs: any = require("ipfs");
const IpfsHttpApi: any = require("ipfs/src/http");

type IPFSNode = {
  apiAddr: {
    toString(): string;
  };
  stop(): Promise<void>;
}

type IPFSHttpServer = {
  start():Promise<void>;
  stop():Promise<void>;
}

class IPFSServer {
  public readonly serverPort = 43134;
  public readonly apiPort = 5001;

  static readonly DEFAULT_PORT = 5001;

  private node:IPFSNode;
  private httpServer:IPFSHttpServer;

  constructor(apiPort) {
    this.apiPort = apiPort;
  }

  async start() {
    // Uses a temp folder for now. 
    let folder = await new Promise((resolve, reject) => {
      fs.mkdtemp(path.join(os.tmpdir(), 'foo-'), (err, folder) => {
        if (err) {
          return reject(err);
        }
        resolve(folder);
      })
    })

    this.node = await JsIpfs.create({
      repo: folder,
      config: {
        Addresses: {
          Swarm: [], // No need to connect to the swarm
          // Note that this config doesn't actually trigger the API and gateway; see below.
          API: `/ip4/127.0.0.1/tcp/${this.apiPort}`,
          Gateway: `/ip4/127.0.0.1/tcp/9090`
        },
        Bootstrap: []
      },
      start: true,
      silent: true
    });

    this.httpServer = new IpfsHttpApi(this.node);

    await this.httpServer.start();
  }

  async stop() {
    await this.httpServer.stop();
    await this.node.stop();
  }
}

export default IPFSServer;

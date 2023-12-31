import type { ActiveQuery } from "libkmodule";
import { addHandler, handleMessage } from "libkmodule";
import { createClient } from "@lumeweb/kernel-swarm-client";
import {
  createServer,
  DummySocket,
  MultiSocketProxy,
} from "@lumeweb/libhyperproxy";
// @ts-ignore
import { SPVNode } from "hsd/lib/node";
import defer from "p-defer";
import dns from "@i2labs/dns";
import assert from "assert";

const PROTOCOL = "lumeweb.proxy.handshake";

onmessage = handleMessage;

let moduleLoadedResolve: Function;
let moduleLoaded: Promise<void> = new Promise((resolve) => {
  moduleLoadedResolve = resolve;
});

addHandler("presentSeed", handlePresentSeed);
addHandler("ready", handleReady);
addHandler("query", handleQuery);

let swarm;
let proxy: MultiSocketProxy;
let node: SPVNode;

function resolveWithPeers(resolve: Function) {
  if (!node.pool.peers.head()) {
    node.pool.on("peer", () => {
      resolveWithPeers(resolve);
    });
    return;
  }

  let syncable = false;

  for (let peer = node.pool.peers.head(); peer; peer = peer.next) {
    if (node.pool.isSyncable(peer)) {
      syncable = true;
      break;
    }
  }

  if (!syncable) {
    for (let peer = node.pool.peers.head(); peer; peer = peer.next) {
      const listener = () => {
        peer.off("open", listener);
        resolve();
      };
      peer.on("open", listener);
    }
    return;
  }

  return resolve(null);
}

async function handlePresentSeed(aq: ActiveQuery) {
  swarm = createClient();

  const peerConnected = defer();
  node = new SPVNode({
    config: false,
    argv: false,
    env: false,
    noDns: true,
    memory: false,
    logFile: false,
    logConsole: true,
    logLevel: "info",
    workers: true,
    network: "main",
    createServer,
    createSocket: (port: number, host: string) => {
      const socket = proxy.createSocket({
        host,
        port,
      }) as unknown as DummySocket;
      socket.connect();

      return socket;
    },
  });

  node.pool.hosts.resolve = async (host: any, family?: any) => {
    if (family == null) family = null;

    assert(family === null || family === 4 || family === 6);

    const stub = new dns.promises.Resolver();

    stub.setServers([
      // Cloudflare
      "1.1.1.1",
      // Google
      "8.8.8.8",
      "8.8.4.4",
      // OpenDNS
      "208.67.222.222",
      "208.67.220.220",
      "208.67.222.220",
      "208.67.220.222",
    ]);

    const out = [];
    const types = [];

    if (family == null || family === 4) types.push("A");

    if (family == null || family === 6) types.push("AAAA");

    for (const type of types) {
      let addrs;

      try {
        addrs = await stub.resolve(host, type as any);
      } catch (e) {
        continue;
      }

      // @ts-ignore
      out.push(...addrs);
    }

    if (out.length === 0) throw new Error("No DNS results.");

    return out;
  };

  if (node?.http?.http?.listen) {
    node.http.http.listen = (port: number, host: string, cb: Function) => cb();
  }

  proxy = new MultiSocketProxy({
    protocol: PROTOCOL,
    swarm,
    server: false,
    autostart: true,
    listen: true,
  });

  proxy.on("peerChannelOpen", () => {
    peerConnected.resolve();
  });

  swarm.join(PROTOCOL);
  await swarm.start();

  await peerConnected.promise;

  await node.open();
  await node.connect();
  await node.startSync();

  moduleLoadedResolve();
}

async function handleReady(aq: ActiveQuery) {
  await moduleLoaded;

  await new Promise((resolve): void => {
    if (node.chain.synced) {
      return resolveWithPeers(resolve);
    }

    node.pool.once("full", () => {
      resolveWithPeers(resolve);
    });
  });

  aq.respond();
}

async function handleQuery(aq: ActiveQuery) {
  if (!node.chain.synced || !node.pool.peers.head()) {
    aq.reject("not ready");
    return;
  }

  try {
    aq.respond(await node.rpc.call(aq.callerInput));
  } catch (e) {
    aq.reject((e as Error).message);
  }
}

export type NodeAddress = string; // Example: 0.0.0.0:12345
export type NodeId = string;
export type NodeState = 'removed' | 'citizen' | 'leader';

export type NodeInfo = {
  id: NodeId,
  weight: number,
  state: NodeState,
  channels: Array<string>,
  last: number, // ms timestamp
  voters: Array<NodeId>,
  source: NodeAddress,
  disconnected?: NodeJS.Timer,
};

// Used for this._nodes
export type NodeInfoMap = { [id: NodeId]: NodeInfo };

export type NodeAddressTuple = [ domain: string, port: number];

export type DemocracyOptions = {
  interval?: number,
  timeout?: number,
  maxPacketSize?: number,
  source?: NodeAddress,
  peers?: Array<NodeAddress>,
  weight?: number
  id?: NodeId,
  channels?: Array<string>,
  enableStrictWeightMode?: boolean,
  autoStart?: boolean,
};
export type DemocracyDefaultedOptions = {
  interval: number,
  timeout: number,
  maxPacketSize: number,
  source: NodeAddressTuple,
  peers: Array<NodeAddressTuple>,
  weight: number,
  id: NodeId,
  channels: Array<string>,
  enableStrictWeightMode: boolean,
  autoStart: boolean,
};

export type SendExtra = {
  candidate?: string,
  channel?: string,
  [key: string]: any,
};

// ProcessEvent Types
export type ChunkMsg = {
  id: NodeId,
  chunk: string,
  c: number, // number of chunks
  i: number, // chunk number
};

type BaseMsg = {
  id: NodeId,
  source: NodeAddress,
};

export type NodeInfoMsg = BaseMsg & {
  weight: number,
  state: NodeState,
  channels?: Array<string>,
};

export type HelloMsg = NodeInfoMsg & {
  event: 'hello',
};

export type LeaderMsg = NodeInfoMsg & {
  event: 'leader',
};

export type SubscribeMsg = NodeInfoMsg & {
  event: 'subscribe',
  extra: SendExtra,
};

export type CustomMsg = BaseMsg & {
  event: string,
  extra: SendExtra,
};

export type VoteMsg = BaseMsg & {
  event: 'vote',
  candidate: NodeId,
};

export type MsgData = ChunkMsg | VoteMsg | HelloMsg | LeaderMsg | SubscribeMsg | CustomMsg;

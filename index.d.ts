// This file is provided for TypeScript consumers.
// The author does not use TypeScript and does not guarantee its correctness.
// Use at your own risk. The real world is messy, this doesn't solve that.
export interface PanAgentOptions {
  url: string;
  token: string;
  appId: string;
  ttl?: number;
}

export class PanAgent {
  constructor(options: PanAgentOptions);
  connect(): Promise<void>;
  getGroupId(groupName: string, key?: string): string;
  getMessageType(type: string, namespace?: string): string;
  joinGroup(groupId: string, msgTypes?: string[]): PanGroup;
  sendDirect(nodeId: string, connId: string, msgType: string, payload: any): void;
}

export class PanGroup {
  on(msgType: string, handler: (msg: any) => void): void;
  send(msgType: string, payload: any): string;
}

// WebRTC transport for online play: one RTCPeerConnection with one ordered, reliable data channel.
// There is no signalling server. The host makes an offer, waits for ICE gathering to finish (no
// trickle) and turns it into an invite code; the guest answers with a reply code; the host pastes it.
// Public STUN servers find each side's public address. There is no TURN relay, so two peers behind
// symmetric NATs (some mobile and corporate networks) cannot connect.
import { compress, expand, SdpError } from './sdp';
import type { Transport } from './netgame';

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
/** Longest wait for ICE gathering; the code is made from whatever was found by then. */
const GATHER_MS = 4000;
/** After the reply is applied, how long the channel may take to open. */
const CONNECT_MS = 20000;
/** How long a connection may stay 'disconnected' before it counts as lost. */
const UNSTABLE_MS = 8000;

export type LinkState = 'waiting' | 'connecting' | 'open' | 'unstable' | 'closed';

export class Link implements Transport {
  onMessage: ((data: unknown) => void) | null = null;
  onClose: ((why: string) => void) | null = null;
  /** The channel opened (the first time). */
  onOpen: (() => void) | null = null;
  onState: ((s: LinkState) => void) | null = null;
  state: LinkState = 'waiting';
  readonly pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  private dc: RTCDataChannel | null = null;
  private timer = 0; private guest = false; private opened = false;

  private constructor() {
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      // A guest's checks go unanswered until the host applies the reply, which can take minutes: its
      // ICE may report 'failed' meanwhile and still recover once the host's checks arrive.
      if (s === 'failed' && (this.opened || !this.guest)) this.end('failed');
      else if (s === 'disconnected' && this.state === 'open') {
        this.set('unstable');
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => { if (this.state === 'unstable') this.end('lost'); }, UNSTABLE_MS);
      } else if (s === 'connected' && this.state === 'unstable') this.set('open');
    };
  }

  /** Host: create a link and its invite code. */
  static async host(): Promise<{ link: Link; code: string }> {
    const l = new Link();
    l.bind(l.pc.createDataChannel('xiangqi', { ordered: true }));
    await l.pc.setLocalDescription(await l.pc.createOffer());
    return { link: l, code: await l.local() };
  }
  /** Guest: answer an invite (a code or a link containing one) with a reply code. */
  static async join(invite: string): Promise<{ link: Link; code: string }> {
    const d = await expand(invite);
    if (d.type !== 'offer') throw new SdpError('Not an invite');
    const l = new Link();
    l.guest = true;
    l.pc.ondatachannel = (e) => l.bind(e.channel);
    try {
      await l.pc.setRemoteDescription(d);
      await l.pc.setLocalDescription(await l.pc.createAnswer());
      l.set('connecting');
      return { link: l, code: await l.local() };
    } catch (e) { l.close(); throw e; }
  }
  /** Host: apply the guest's reply; the channel opens shortly after (or the link closes as 'timeout'). */
  async accept(reply: string) {
    const d = await expand(reply);
    if (d.type !== 'answer') throw new SdpError('Not a reply');
    if (this.pc.signalingState !== 'have-local-offer') throw new SdpError('Reply already used');
    await this.pc.setRemoteDescription(d);
    this.set('connecting');
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { if (this.state === 'connecting') this.end('timeout'); }, CONNECT_MS);
  }

  send(text: string) { if (this.dc?.readyState === 'open') this.dc.send(text); }
  close() {
    if (this.state === 'closed') return;
    this.set('closed'); clearTimeout(this.timer);
    this.onMessage = this.onClose = null;
    try { this.dc?.close(); this.pc.close(); } catch { /* already gone */ }
  }

  private bind(dc: RTCDataChannel) {
    this.dc = dc;
    dc.onopen = () => { clearTimeout(this.timer); this.opened = true; this.set('open'); this.onOpen?.(); };
    dc.onmessage = (e) => this.onMessage?.(e.data);
    dc.onclose = () => this.end('lost');
  }
  private set(s: LinkState) { if (this.state === s) return; this.state = s; this.onState?.(s); }
  private end(why: string) { if (this.state === 'closed') return; const f = this.onClose; this.close(); f?.(why); }
  /** The local description as a code, once ICE gathering has finished (or GATHER_MS has passed). */
  private async local(): Promise<string> {
    const pc = this.pc;
    await new Promise<void>((done) => {
      if (pc.iceGatheringState === 'complete') { done(); return; }
      const t = setTimeout(done, GATHER_MS);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); done(); } });
    });
    const d = pc.localDescription!;
    return compress({ type: d.type as 'offer' | 'answer', sdp: d.sdp });
  }
}

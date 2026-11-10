// Run with: npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Engine, sq, type Side } from '../src/engine.ts';
import { encode } from '../src/record.ts';
import { MemoryTransport, NetGame, MAX_MESSAGE, PROTOCOL, TIMEOUT, type Ask } from '../src/netgame.ts';
import { SdpError, codeOf, compress, expand, fields } from '../src/sdp.ts';

// ---------- signalling codes ----------
const fixtures: { note: string; type: 'offer' | 'answer'; sdp: string }[] = JSON.parse(readFileSync(new URL('./fixtures/sdp.json', import.meta.url), 'utf8'));
const essentials = (sdp: string) => { const f = fields(sdp); return { ...f, fingerprint: f.fingerprint.toUpperCase().replace('SHA-', 'sha-') }; };
async function roundTrip(type: 'offer' | 'answer', sdp: string, packed = true) {
  const code = await compress({ type, sdp });
  assert.equal(code[0], packed ? '1' : 'Z', 'code form');
  assert.match(code, /^[A-Za-z0-9_-]+$/, 'URL-safe');
  const d = await expand(code);
  assert.equal(d.type, type);
  assert.deepEqual(essentials(d.sdp), essentials(sdp), 'fields survive');
  assert.equal(await compress(d), code, 'idempotent');
  assert.deepEqual(await expand('https://example.org/fable-chess/?q=low#join=' + code), d, 'a whole link expands');
  return code;
}
for (const f of fixtures) {
  const code = await roundTrip(f.type, f.sdp);
  assert.ok(code.length < 160, `${f.note}: ${code.length} chars`);
  console.log(`  ${f.type} ${f.sdp.length} chars of SDP -> ${code.length} chars`);
}
{
  // IPv6, a plain host name, TCP candidates (dropped), another mid: still packed.
  const base = fixtures[0].sdp.replace('a=mid:0', 'a=mid:data');
  const extra = 'a=candidate:9 1 udp 2122197247 2001:db8::1:0:0:5 61000 typ host generation 0\r\n'
    + 'a=candidate:10 1 udp 2122197247 2001:db8::7 61001 typ host generation 0\r\n'
    + 'a=candidate:11 1 udp 1686052607 router.example 4000 typ srflx raddr 0.0.0.0 rport 0\r\n'
    + 'a=candidate:12 1 tcp 1518280447 203.0.113.9 9 typ host tcptype active\r\n';
  const sdp = base.replace('a=ice-ufrag', extra + 'a=ice-ufrag');
  await roundTrip('offer', sdp);
  const f = fields((await expand(await compress({ type: 'offer', sdp }))).sdp);
  assert.deepEqual(f.candidates.map((c) => c.address).slice(2), ['2001:db8::1:0:0:5', '2001:db8::7', 'router.example']);
  assert.equal(f.mid, 'data');
  // A different hash falls back to deflate, which keeps the SDP verbatim.
  const odd = fixtures[1].sdp.replace(/sha-256 [0-9A-F:]+/, 'sha-384 ' + Array(48).fill('AB').join(':'));
  const z = await compress({ type: 'answer', sdp: odd });
  assert.equal(z[0], 'Z');
  assert.deepEqual(await expand(z), { type: 'answer', sdp: odd });
  // Malformed codes are refused with SdpError, never anything else.
  const good = await compress(fixtures[0]);
  for (const bad of ['', 'Q', '1', good.slice(0, 20), good.slice(0, -3), good + 'AAAA', good.replace(/.$/, '*'), '1z' + good.slice(2), 'Z!!!!', 'ZAAAA', '1' + 'A'.repeat(5000)])
    await assert.rejects(expand(bad), SdpError, JSON.stringify(bad.slice(0, 30)));
  assert.equal(codeOf(' https://x.org/#join=1abc \n'), '1abc');
  assert.equal(codeOf('1ab\ncd'), '1abcd');
}

// ---------- protocol ----------
let clock = 0;
const now = () => clock;
/** A connected host and guest; `side` is the host's. */
function connect(side: Side = 'r', o: { record?: string; game?: number } = {}) {
  const [a, b] = MemoryTransport.pair();
  const host = new NetGame(a, { role: 'host', side, now, ...o }), guest = new NetGame(b, { role: 'guest', now });
  const log = { host: [] as string[], guest: [] as string[] };
  for (const [g, l] of [[host, log.host], [guest, log.guest]] as const) {
    g.on = { ask: (k) => l.push('ask ' + k), lapsed: (k) => l.push('lapsed ' + k), answered: (k, y) => l.push(`answered ${k} ${y}`), rejected: (w) => l.push('rejected ' + w), closed: (w) => l.push('closed ' + w), change: (w) => l.push('change ' + w) };
  }
  guest.open(); host.open();
  assert.ok(host.ready && guest.ready, 'hello exchanged');
  return { host, guest, a, b, log };
}
const same = (x: NetGame, y: NetGame) => { assert.equal(x.record, y.record); assert.equal(x.game, y.game); assert.deepEqual(x.result, y.result); assert.equal(x.side, y.peer); };
const mv = (g: NetGame, s: string) => g.move(sq(s.slice(0, 2)), sq(s.slice(2, 4)));
/** Whoever's turn it is plays `s`. */
const play = (p: { host: NetGame; guest: NetGame }, s: string) => { const g = p.host.engine.turn === p.host.side ? p.host : p.guest; assert.ok(mv(g, s), s); same(p.host, p.guest); };

// A full game to checkmate, each side moving in turn, in sync after every ply.
{
  // Seeded random play preferring captures and taking a mate when it sees one; first seed that mates.
  let moves: { from: number; to: number }[] = [];
  for (let seed = 1; !moves.length; seed++) {
    const e = new Engine();
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
    while (!e.status().over && e.history.length < 400) {
      const all = e.legalMoves();
      const mate = all.find((m) => { e.move(m.from, m.to); const st = e.status(); e.undo(); return st.reason === 'checkmate'; });
      const caps = all.filter((m) => e.board[m.to]), pick = mate ? [mate] : caps.length && rnd() < 0.7 ? caps : all;
      const m = pick[(rnd() * pick.length) | 0];
      e.move(m.from, m.to);
    }
    if (e.status().reason === 'checkmate') moves = e.history.map((m) => ({ from: m.from, to: m.to }));
  }
  const p = connect('b'); // the guest plays red
  assert.equal(p.guest.side, 'r');
  for (const m of moves) {
    const mover = p.host.engine.turn === p.host.side ? p.host : p.guest, idle = mover === p.host ? p.guest : p.host;
    assert.equal(idle.move(m.from, m.to), false, 'the idle side cannot move');
    assert.ok(mover.move(m.from, m.to));
    same(p.host, p.guest);
  }
  assert.equal(p.host.engine.status().reason, 'checkmate');
  assert.ok(p.host.over && p.guest.over && !p.host.myTurn && !p.guest.myTurn);
  assert.ok(!p.log.host.some((l) => l.startsWith('rejected')) && !p.log.guest.some((l) => l.startsWith('rejected')));
  console.log(`  full game to checkmate in sync: ${moves.length} plies`);
}

// Hostile and broken messages are refused without changing anything; the game then continues.
{
  const p = connect('r');
  play(p, 'h2e2'); play(p, 'h9g7');
  const before = p.guest.record, raw = (m: unknown) => p.a.send(typeof m === 'string' ? m : JSON.stringify(m));
  const cases: unknown[] = [
    { t: 'move', g: 0, ply: 2, from: sq('b9'), to: sq('c7') },   // black's move on red's turn: wrong side
    { t: 'move', g: 0, ply: 2, from: sq('e2'), to: sq('e9') },   // red cannon onto the black king: illegal
    { t: 'move', g: 0, ply: 5, from: sq('h0'), to: sq('g2') },   // legal move, wrong ply
    { t: 'move', g: 0, ply: 1, from: sq('h0'), to: sq('g2') },   // a stale ply
    { t: 'move', g: 3, ply: 2, from: sq('h0'), to: sq('g2') },   // another game
    { t: 'move', g: 0, ply: 2, from: 'h0', to: 'g2' },           // strings for squares
    { t: 'move', g: 0, ply: 2, from: 95, to: -1 },
    { t: 'move', g: 0, ply: 2.5, from: sq('h0'), to: sq('g2') },
    { t: 'draw-accept', g: 0, ply: 2 }, { t: 'undo-accept', g: 0, ply: 2 }, { t: 'rematch', game: 1 }, { t: 'resign', g: 7 },
    { t: 'sync', game: 0, side: 'b', record: '1.' }, // only the host may sync
    { t: 'nonsense' }, { nothing: true }, [1, 2], null, 42, 'not json {', '"just a string"',
    JSON.stringify({ t: 'move', pad: 'x'.repeat(MAX_MESSAGE) }),
  ];
  for (const c of cases) {
    // From the guest to the host (the host answers disagreement with a sync, which changes nothing).
    p.b.send(typeof c === 'string' ? c : JSON.stringify(c));
    assert.equal(p.host.record, before, JSON.stringify(c));
    assert.equal(p.guest.record, before);
  }
  p.b.send(new Uint8Array(4) as unknown as string); // binary data
  assert.equal(p.host.record, before);
  // From the host to the guest (the guest asks the host for the record).
  raw({ t: 'move', g: 0, ply: 2, from: sq('b9'), to: sq('c7') });
  raw({ t: 'sync', game: 0, side: 'b', record: '1.%%%' });     // bad record: refused
  raw({ t: 'sync', game: 0, side: 'q', record: before });
  assert.equal(p.guest.record, before); assert.equal(p.guest.side, 'b');
  const rejected = p.log.host.filter((l) => l.startsWith('rejected')).length;
  assert.equal(rejected, cases.length + 1, 'every bad message was refused');
  assert.ok(p.host.resyncs > 0 && p.guest.resyncs > 0);
  assert.ok(!p.host.closed && !p.guest.closed);
  play(p, 'h0g2'); play(p, 'i9h9'); // and the game goes on
  same(p.host, p.guest);
}

// A diverged guest is resynced from the host's record.
{
  const p = connect('r');
  play(p, 'h2e2'); play(p, 'h9g7');
  p.guest.engine.undo(); // the guest's copy loses a move
  assert.ok(mv(p.host, 'h0g2'));                    // its ply no longer matches: rejected, then resynced
  same(p.host, p.guest);
  assert.equal(p.guest.engine.history.length, 3);
  assert.ok(p.log.guest.includes('change sync'));
  // A wild guest record is overwritten too; the host never adopts the guest's.
  p.guest.engine = new Engine(); p.guest.engine.move(sq('b0'), sq('c2')); p.guest.engine.move(sq('b9'), sq('c7')); p.guest.engine.move(sq('a3'), sq('a4'));
  clock += 1000; p.b.send(JSON.stringify({ t: 'sync-request' }));
  same(p.host, p.guest);
  const sent = p.a.sent;
  p.b.send(JSON.stringify({ t: 'sync-request' })); // a second one at once goes unanswered
  assert.equal(p.a.sent, sent);
}

// Resume after a disconnect: a new link, the host's game, the sides kept.
{
  const p = connect('b');
  play(p, 'h2e2'); play(p, 'h9g7'); play(p, 'h0g2');
  p.host.close('leave');
  assert.equal(p.guest.closed, 'bye');
  assert.equal(p.host.move(sq('h7'), sq('h0')), false, 'no moves after close');
  const q = connect(p.host.side, { record: p.host.record, game: p.host.game });
  same(q.host, q.guest);
  assert.equal(q.guest.side, 'r'); assert.equal(q.guest.engine.history.length, 3);
  play(q, 'i9h9');
}

// Resignation, draw offer declined then accepted, undo declined then accepted.
{
  const p = connect('r');
  assert.ok(p.host.resign());
  same(p.host, p.guest);
  assert.deepEqual(p.guest.result, { winner: 'b', reason: 'resign' });
  assert.ok(p.host.over && p.guest.over && !p.guest.myTurn);
  assert.equal(p.guest.resign(), false);
}
{
  const p = connect('r');
  play(p, 'h2e2');
  assert.equal(p.guest.offer('draw'), false, 'offers are made on the opponent\'s turn');
  assert.ok(p.host.offer('draw'));
  assert.equal(p.host.offer('draw'), false, 'one at a time');
  assert.deepEqual(p.log.guest.slice(-1), ['ask draw']);
  assert.ok(p.guest.answer('draw', false));
  assert.deepEqual(p.log.host.slice(-1), ['answered draw false']);
  assert.equal(p.host.result, null);
  // An offer lapses when the opponent simply moves.
  assert.ok(p.host.offer('draw'));
  play(p, 'h9g7');
  assert.ok(p.log.guest.includes('lapsed draw'));
  assert.equal(p.guest.answer('draw', true), false);
  assert.deepEqual(p.host.mine, {});
  // Accepted.
  play(p, 'h0g2');
  assert.ok(p.host.offer('draw') && p.guest.answer('draw', true));
  same(p.host, p.guest);
  assert.deepEqual(p.host.result, { winner: null, reason: 'draw' });
  assert.equal(mv(p.guest, 'i9h9'), false, 'no moves after the end');
}
{
  const p = connect('r');
  assert.equal(p.host.offer('undo'), false, 'nothing to take back');
  play(p, 'h2e2');
  assert.ok(p.host.offer('undo'));
  assert.ok(p.guest.answer('undo', false));
  assert.equal(p.guest.engine.history.length, 1);
  assert.ok(p.host.offer('undo'));
  assert.ok(p.guest.answer('undo', true));
  same(p.host, p.guest);
  assert.equal(p.host.engine.history.length, 0);
  assert.ok(p.host.myTurn);
  play(p, 'b2e2');
}

// Rematch: colours swap, the game number advances; crossing requests agree.
{
  const p = connect('r');
  play(p, 'h2e2');
  assert.equal(p.host.rematch(), false, 'only after the end');
  p.guest.resign();
  assert.ok(p.host.rematch());
  assert.deepEqual(p.log.guest.slice(-1), ['ask rematch']);
  assert.ok(p.guest.answer('rematch', false));
  assert.equal(p.host.game, 0);
  assert.ok(p.guest.rematch());
  assert.ok(p.host.rematch(), 'asking back is agreeing');
  same(p.host, p.guest);
  assert.equal(p.host.game, 1); assert.equal(p.host.side, 'b'); assert.equal(p.guest.side, 'r');
  assert.equal(p.host.engine.history.length, 0);
  play(p, 'h2e2');
  // Both ask at once.
  p.host.resign();
  p.a.hold = p.b.hold = true;
  assert.ok(p.host.rematch()); assert.ok(p.guest.rematch());
  p.a.hold = p.b.hold = false; p.a.flush(); p.b.flush();
  same(p.host, p.guest);
  assert.equal(p.host.game, 2); assert.equal(p.host.side, 'r');
  assert.ok(!p.log.host.concat(p.log.guest).some((l) => l.startsWith('rejected')));
}

// Messages crossing in flight: a resignation against a move ends the same way on both sides.
{
  const p = connect('r');
  play(p, 'h2e2');
  p.a.hold = p.b.hold = true;
  assert.ok(mv(p.guest, 'h9g7'));
  assert.ok(p.host.resign());
  p.a.hold = p.b.hold = false; p.a.flush(); p.b.flush();
  same(p.host, p.guest);
  assert.ok(p.host.over);
  assert.equal(p.guest.engine.history.length, 1, 'the host\'s game is authoritative');
}

// Flood: the rate limit drops excess messages, persistent abuse ends the session.
{
  const p = connect('r');
  for (let i = 0; i < 60; i++) p.b.send(JSON.stringify({ t: 'ping', n: i }));
  assert.ok(p.log.host.includes('rejected rate'));
  assert.ok(!p.host.closed);
  clock += 5000;
  for (let i = 0; i < 40; i++) p.b.send('garbage');
  assert.equal(p.host.closed, 'abuse');
  assert.equal(p.guest.closed, 'bye'); // told by the host's goodbye
}

// Version mismatch, heartbeat latency and timeout.
{
  const [a, b] = MemoryTransport.pair();
  const host = new NetGame(a, { role: 'host', side: 'r', now });
  let why = '';
  host.on.closed = (w) => { why = w; };
  b.onMessage = () => {};
  host.open();
  b.send(JSON.stringify({ t: 'hello', v: PROTOCOL + 1 }));
  assert.equal(why, 'version');
}
{
  const p = connect('r');
  clock += 5000; p.host.heartbeat();
  assert.equal(p.host.latency, 0, 'pong answered at once');
  p.a.hold = true; // the host hears nothing more
  clock += 2000; p.host.heartbeat(); // a ping goes out, no pong comes back
  clock += TIMEOUT; p.host.heartbeat();
  assert.equal(p.host.closed, 'timeout');
}

// The guest takes its side and game from the host's hello.
{
  const e = new Engine(); for (const m of ['h2e2', 'h9g7']) e.move(sq(m.slice(0, 2)), sq(m.slice(2)));
  const p = connect('b', { record: encode(e), game: 4 });
  assert.equal(p.guest.side, 'r'); assert.equal(p.guest.game, 4); same(p.host, p.guest);
  play(p, 'h0g2'); assert.ok(p.guest.offer('undo'));
  assert.deepEqual(p.log.host.slice(-1), ['ask undo' satisfies `ask ${Ask}`]);
}

console.log('net tests passed');

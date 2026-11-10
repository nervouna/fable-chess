// Classic games from the public-domain manuals 橘中秘 (朱晉楨, 1632) and 梅花譜 (王再越, Kangxi era),
// stored as the manuals' own move text and read through the notation parser when picked.
//
// Provenance. Each line was copied by script from the source named beside it (comments and variations
// stripped, the source's spelling kept), then checked move by move against a second transcription:
// - 橘中秘: the 象棋巫師 / xqbase PGN files, as mirrored in github.com/liangqi/xqwizard at commit
//   eab4a994 (2013), checked against the dpxq.com records on xiangqiqipu.com or xqdao.com.
// - 梅花譜: see each entry. The manuals' lines often stop once one side is clearly lost.
import { decode, type GameRecord } from './record.ts';
import type { EndReason, Side } from './engine.ts';

export interface Classic {
  /** Title, in traditional glyphs. */
  title: string;
  /** Manual and chapter. */
  source: string;
  /** One line on what happens. */
  blurb: string;
  /** The moves, in the manual's notation. */
  moves: string;
  /** How the line ends where the source says so (shown on the closing card). */
  result?: string;
  /** The side the source says is winning, when the line stops short of mate. */
  winner?: Side;
  /** The engine's verdict on the final position, when the line plays to mate. */
  end?: { reason: EndReason; winner: Side };
}

export const CLASSICS: Classic[] = [
  {
    // github.com/liangqi/xqwizard/blob/eab4a994/XQWIZARD/橘中秘/1.得先/1-01.顺炮横车破直车弃马.PGN
    // checked: https://www.xiangqiqipu.com/Category/View-8289.html, http://m.xqdao.com/qipu/show/69075/
    title: '棄馬十三著', source: '橘中秘 · 得先第一局', result: '紅勝',
    blurb: '顺炮横车破直车：第六着弃马设伏，黑贪马中计，十三回合绝杀。',
    end: { reason: 'checkmate', winner: 'r' },
    moves: `1. 炮二平五 炮８平５
2. 马二进三 马８进７
3. 车一进一 车９平８
4. 车一平六 车８进６
5. 车六进七 马２进１
6. 车九进一 炮２进７
7. 炮八进五 马７退８
8. 炮五进四 士６进５
9. 车九平六 将５平６
10. 前车进一 士５退４
11. 车六平四 炮５平６
12. 车四进六 将６平５
13. 炮八平五`,
  },
  {
    // github.com/liangqi/xqwizard/blob/eab4a994/XQWIZARD/橘中秘/1.得先/1-03.顺炮横车破直车不食弃马.PGN
    // checked: https://www.xiangqiqipu.com/Category/View-8261.html
    title: '不食棄馬', source: '橘中秘 · 得先第三局', result: '紅勝',
    blurb: '同一弃马，黑方识破不吃，补士固守；红双炮沉底连环，仍成绝杀。',
    end: { reason: 'checkmate', winner: 'r' },
    moves: `1. 炮二平五 炮８平５
2. 马二进三 马８进７
3. 车一进一 车９平８
4. 车一平六 车８进６
5. 车六进七 马２进１
6. 车九进一 士６进５
7. 车九平四 炮２平４
8. 车四进七 车１平２
9. 炮八进六 卒３进１
10. 炮五平八 马１进３
11. 后炮进七 马３退４
12. 后炮平七 车８平７
13. 马三退一 炮５进４
14. 炮八退二 炮４进２
15. 帅五进一 车７进２
16. 帅五进一 车７平９
17. 炮八平七 象３进１
18. 前炮平八 士５进４
19. 车四平六 炮４退３
20. 炮七进二 士４进５
21. 炮八进一`,
  },
  {
    // github.com/liangqi/xqwizard/blob/eab4a994/XQWIZARD/橘中秘/1.得先/1-16.大列手炮局.PGN
    // checked: https://www.xiangqiqipu.com/Category/View-8111.html, http://m.xqdao.com/qipu/show/69068/
    title: '大列手炮', source: '橘中秘 · 得先第十六局', result: '紅勝',
    blurb: '斗炮之局：双方直车边马对峙，红马跃入敌营，车炮破宫成杀。',
    end: { reason: 'checkmate', winner: 'r' },
    moves: `1. 炮二平五 炮２平５
2. 马二进三 马８进９
3. 车一平二 车９平８
4. 马八进九 马２进３
5. 车九平八 车１平２
6. 兵九进一 卒９进１
7. 车二进四 车２进４
8. 马九进八 车２平６
9. 车二平六 马９进８
10. 马八进六 卒３进１
11. 马六进七 炮８平３
12. 炮八进七 士６进５
13. 炮五进四 将５平６
14. 车八进八 车８进１
15. 车八平五 车８平５
16. 车六进五 车５退１
17. 车六平五 将６进１
18. 车五平四`,
  },
  {
    // github.com/liangqi/xqwizard/blob/eab4a994/XQWIZARD/橘中秘/1.得先/1-20.屏风马破当头炮.PGN
    // checked: https://www.xiangqiqipu.com/Category/View-8049.html, http://m.xqdao.com/qipu/show/69070/
    title: '先手屏風馬', source: '橘中秘 · 得先第二十局',
    blurb: '红方先起屏风马迎当头炮，沉炮换马，双车直捣中宫。',
    moves: `1. 马二进三 炮８平５
2. 马八进七 马８进７
3. 兵三进一 车９平８
4. 车一平二 车８进６
5. 相七进五 卒３进１
6. 仕六进五 炮２平３
7. 车九平六 车８平７
8. 炮二进七 马７退８
9. 车二进九 车７进１
10. 炮八进四 卒７进１
11. 炮八平一 象７进９
12. 车六进八 马２进１
13. 车二退三 卒５进１
14. 车二平六 士６进５
15. 炮一平五 将５平６
16. 炮五进二 士４进５
17. 前车平五`,
  },
  {
    // github.com/liangqi/xqwizard/blob/eab4a994/XQWIZARD/橘中秘/2.让先/2-11.让先-小列手炮弃相陷车.PGN (the source's last note: 死车)
    // checked: https://www.xiangqiqipu.com/Category/View-7879.html, http://m.xqdao.com/qipu/show/69085/
    title: '棄象陷車', source: '橘中秘 · 讓先第十一局', result: '紅車已死', winner: 'b',
    blurb: '小列手炮：黑方退马弃象，诱红车深入吃底，七回合即成死车。',
    moves: `1. 炮二平五 炮２平５
2. 马二进三 马２进３
3. 车一平二 马８进７
4. 车二进六 车１进１
5. 车二平三 马７退８
6. 车三进三 炮５平７
7. 马八进九 象３进５`,
  },
  {
    // 梅花譜, 屏風馬破當頭炮 第一局 (破巡河車吃卒用炮打象): text from https://gj.zdic.net/zibu/308
    // checked: https://www.xiangqiqipu.com/Category/View-7883.html, and the left-right mirrored line at
    // https://baike.baidu.com/item/梅花谱/6069907 (which ends 黑得车胜)
    title: '屏風馬破當頭炮', source: '梅花譜 · 屏風馬第一局', result: '黑勝', winner: 'b',
    blurb: '梅谱开宗名局：屏风马后发制人，马炮联攻逼帅出宫，黑方得车。',
    moves: `1. 炮八平五 马２进３
2. 马八进七 卒７进１
3. 车九平八 车１平２
4. 车八进四 马８进７
5. 兵三进一 卒７进１
6. 车八平三 卒３进１
7. 炮二平三 马７进８
8. 车三进一 炮２进２
9. 车三平七 马８进６
10. 车七进二 象７进５
11. 车七退三 马６进８
12. 马二进一 马８进６
13. 帅五进一 炮２平６
14. 帅五平六 炮８进６
15. 车一平二 车９进１
16. 车七平六 车２进８
17. 帅六进一 马６进５
18. 炮五退一 车２平４
19. 帅六平五 车４退３`,
  },
  {
    // 梅花譜, 順炮橫車破直車 第一局 (攻直車過河捉馬士角炮): the dpxq.com record (coordinates), at
    // https://www.xiangqiqipu.com/Category/View-7984.html and http://m.xqdao.com/qipu/show/64442
    // (result 红胜). Both copies are one transcription; no independent text was found.
    title: '橫車破直車', source: '梅花譜 · 順炮橫車第一局', result: '紅勝',
    blurb: '顺炮横车：红车塞象眼，马踏中路，双炮重叠成杀。',
    end: { reason: 'checkmate', winner: 'r' },
    moves: `1. 炮二平五 炮8平5
2. 马二进三 马8进7
3. 车一进一 车9平8
4. 车一平六 士4进5
5. 车六进七 马2进1
6. 兵七进一 车8进6
7. 马八进七 车8平7
8. 马七进六 卒7进1
9. 马六进七 炮2平4
10. 马七进五 象7进5
11. 炮八进五 马7进6
12. 炮五进四 车7进1
13. 炮五平三 车7平2
14. 炮八平五 士5进6
15. 炮三平五`,
  },
];

/** The classic as a game record (throws RecordError if its text does not play through the engine). */
export function classicRecord(c: Classic): GameRecord { return decode(c.moves); }

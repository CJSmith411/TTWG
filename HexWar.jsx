import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";

/* ============================================================
   HEX WAR — a Battletech-era tabletop wargame, in the browser
   Phased turns: MOVEMENT PHASE -> WEAPON PHASE -> ENEMY PHASE
   ============================================================ */

const SIZE = 34; // hex radius in px
const COLS = 9;
const ROWS = 6;
const VB_W = 1.5 * SIZE * COLS + SIZE * 1.5;
const VB_H = Math.sqrt(3) * SIZE * (ROWS + 1);
const PAD_X = SIZE;
const PAD_Y = SIZE * 0.9;

const AXIAL_DIRS = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];

const BLOCKED = new Set(["3,2", "4,3", "5,1", "2,4", "6,2"]);

const COLORS = {
  paper: "#d9d2b6",
  paperDark: "#c7bf9e",
  ink: "#282420",
  gridLine: "#9c9474",
  gunmetal: "#4a5049",
  rust: "#a8461f",
  steelPrimary: "#33586e",
  steelDark: "#1c3440",
  steelHi: "#8fb8c9",
  bloodPrimary: "#7a2c2c",
  bloodDark: "#3d1616",
  bloodHi: "#d99a8f",
  warn: "#c9a227",
  moveHi: "#5c7a4a",
  atkHi: "#a8461f",
};

/* ---------- 8x8 pixel-sprite patterns ---------- */
const SPRITES = {
  mech: [
    "..DBBD..",
    ".DBBBBD.",
    "DBHBBHBD",
    "DBBBBBBD",
    ".DBBBBD.",
    "..D..D..",
    ".DD..DD.",
    "DD....DD",
  ],
  tank: [
    "........",
    ".DBBBBD.",
    "DBBBBBBD",
    "DBHBBHBD",
    "DBBBBBBD",
    "DBBBBBBD",
    ".DDDDDD.",
    "D.D..D.D",
  ],
  trooper: [
    "...DD...",
    "..DBBD..",
    "..DHHD..",
    "..DBBD..",
    ".DBBBBD.",
    "..D..D..",
    "..D..D..",
    ".DD..DD.",
  ],
};

/* ---------- axial / offset hex math ---------- */
function offsetToAxial(col, row) {
  const q = col;
  const r = row - (col - (col & 1)) / 2;
  return { q, r };
}
function axialToOffset(q, r) {
  const col = q;
  const row = r + (q - (q & 1)) / 2;
  return { col, row };
}
function axialDistance(a, b) {
  const ax = a.q, az = a.r, ay = -ax - az;
  const bx = b.q, bz = b.r, by = -bx - bz;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}
function hexToPixel(col, row) {
  const { q, r } = offsetToAxial(col, row);
  const x = SIZE * 1.5 * q + PAD_X + SIZE / 2;
  const y = SIZE * Math.sqrt(3) * (r + q / 2) + PAD_Y + SIZE / 2;
  return { x, y };
}
function hexCorners(cx, cy) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i);
    pts.push(`${cx + SIZE * Math.cos(ang)},${cy + SIZE * Math.sin(ang)}`);
  }
  return pts.join(" ");
}
function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/* ---------- initial roster ---------- */
function makeInitialUnits() {
  return [
    { id: "p1", side: "player", type: "mech", name: "VINDICATOR", mv: 3, rng: 3, arm: 8, skill: 7, dmg: 3, hp: 10, maxHp: 10, col: 0, row: 1, moved: false, fired: false },
    { id: "p2", side: "player", type: "tank", name: "RHINO TANK", mv: 2, rng: 4, arm: 10, skill: 8, dmg: 4, hp: 14, maxHp: 14, col: 0, row: 3, moved: false, fired: false },
    { id: "p3", side: "player", type: "trooper", name: "TROOPER SQD", mv: 4, rng: 2, arm: 4, skill: 6, dmg: 2, hp: 6, maxHp: 6, col: 1, row: 4, moved: false, fired: false },
    { id: "e1", side: "enemy", type: "mech", name: "REAVER", mv: 3, rng: 3, arm: 8, skill: 7, dmg: 3, hp: 10, maxHp: 10, col: 8, row: 1, moved: false, fired: false },
    { id: "e2", side: "enemy", type: "tank", name: "BASILISK", mv: 2, rng: 4, arm: 9, skill: 8, dmg: 4, hp: 13, maxHp: 13, col: 8, row: 3, moved: false, fired: false },
    { id: "e3", side: "enemy", type: "trooper", name: "BLOOD SQD", mv: 4, rng: 2, arm: 4, skill: 6, dmg: 2, hp: 6, maxHp: 6, col: 7, row: 4, moved: false, fired: false },
  ];
}

/* ---------- pip layouts for d6 ---------- */
const PIPS = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};
function Die({ value, dark }) {
  const cell = 7;
  return (
    <svg width="26" height="26" viewBox="0 0 26 26">
      <rect x="1" y="1" width="24" height="24" rx="3" fill={dark ? COLORS.ink : "#efe8d4"} stroke={COLORS.ink} strokeWidth="2" />
      {(PIPS[value] || []).map((idx) => {
        const cx = 4 + (idx % 3) * cell + cell / 2;
        const cy = 4 + Math.floor(idx / 3) * cell + cell / 2;
        return <circle key={idx} cx={cx} cy={cy} r="2.1" fill={dark ? "#efe8d4" : COLORS.ink} />;
      })}
    </svg>
  );
}

function UnitSprite({ type, side, scale = 1 }) {
  const pattern = SPRITES[type] || SPRITES.trooper;
  const cell = (SIZE * 0.95 * scale) / 8;
  const off = -(cell * 8) / 2;
  const body = side === "player" ? COLORS.steelPrimary : COLORS.bloodPrimary;
  const dark = side === "player" ? COLORS.steelDark : COLORS.bloodDark;
  const hi = side === "player" ? COLORS.steelHi : COLORS.warn;
  const map = { B: body, D: dark, H: hi };
  const rects = [];
  pattern.forEach((rowStr, r) => {
    for (let c = 0; c < rowStr.length; c++) {
      const ch = rowStr[c];
      if (ch === ".") continue;
      rects.push(
        <rect key={`${r}-${c}`} x={off + c * cell} y={off + r * cell} width={cell + 0.5} height={cell + 0.5} fill={map[ch]} />
      );
    }
  });
  return <g>{rects}</g>;
}

/* ================= MAIN COMPONENT ================= */
export default function HexWar() {
  const [units, setUnits] = useState(makeInitialUnits);
  const [phase, setPhase] = useState("playerMove"); // playerMove | playerFire | enemyTurn | gameover
  const [selectedId, setSelectedId] = useState(null);
  const [turn, setTurn] = useState(1);
  const [log, setLog] = useState(["BRIEFING: Cobalt Legion, hold the line against the Crimson Host.", "-- YOUR TURN 1: MOVEMENT PHASE --"]);
  const [dice, setDice] = useState(null); // {d1,d2,total,hit,target,rolling}
  const [busy, setBusy] = useState(false);
  const [winner, setWinner] = useState(null);

  const unitsRef = useRef(units);
  useEffect(() => { unitsRef.current = units; }, [units]);
  const logEndRef = useRef(null);
  useEffect(() => { logEndRef.current?.scrollIntoView({ block: "end" }); }, [log]);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Black+Ops+One&family=Share+Tech+Mono&display=swap";
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  const addLog = useCallback((msg) => setLog((l) => [...l, msg]), []);

  const HEXES = useMemo(() => {
    const list = [];
    for (let col = 0; col < COLS; col++) {
      for (let row = 0; row < ROWS; row++) list.push({ col, row, key: `${col},${row}` });
    }
    return list;
  }, []);
  const hexSet = useMemo(() => new Set(HEXES.map((h) => h.key)), [HEXES]);

  const getUnitAt = useCallback((col, row, us = units) => us.find((u) => u.hp > 0 && u.col === col && u.row === row), [units]);
  const selected = units.find((u) => u.id === selectedId) || null;

  const movementRange = useMemo(() => {
    if (!selected || phase !== "playerMove" || selected.moved) return new Set();
    return computeMovementRange(selected, units, hexSet);
  }, [selected, units, hexSet, phase]);

  const attackable = useMemo(() => {
    if (!selected || phase !== "playerFire" || selected.fired) return new Set();
    const s = new Set();
    units.filter((u) => u.side !== selected.side && u.hp > 0).forEach((u) => {
      const a = offsetToAxial(selected.col, selected.row);
      const b = offsetToAxial(u.col, u.row);
      if (axialDistance(a, b) <= selected.rng) s.add(`${u.col},${u.row}`);
    });
    return s;
  }, [selected, units, phase]);

  function computeMovementRange(unit, us, hs) {
    const startAxial = offsetToAxial(unit.col, unit.row);
    const startKey = `${unit.col},${unit.row}`;
    const visited = new Map([[startKey, 0]]);
    let frontier = [{ q: startAxial.q, r: startAxial.r }];
    for (let step = 0; step < unit.mv; step++) {
      const next = [];
      for (const cell of frontier) {
        for (const d of AXIAL_DIRS) {
          const nq = cell.q + d.q, nr = cell.r + d.r;
          const off = axialToOffset(nq, nr);
          const key = `${off.col},${off.row}`;
          if (!hs.has(key) || BLOCKED.has(key) || visited.has(key)) continue;
          if (us.find((u) => u.hp > 0 && u.col === off.col && u.row === off.row)) continue;
          visited.set(key, step + 1);
          next.push({ q: nq, r: nr });
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    visited.delete(startKey);
    return new Set(visited.keys());
  }

  function checkWin(us) {
    const playersAlive = us.some((u) => u.side === "player" && u.hp > 0);
    const enemiesAlive = us.some((u) => u.side === "enemy" && u.hp > 0);
    if (!playersAlive) { setWinner("enemy"); setPhase("gameover"); addLog("*** ALL COBALT UNITS DESTROYED — DEFEAT ***"); return true; }
    if (!enemiesAlive) { setWinner("player"); setPhase("gameover"); addLog("*** CRIMSON HOST ELIMINATED — VICTORY ***"); return true; }
    return false;
  }

  async function resolveAttack(attacker, defenderId) {
    setBusy(true);
    for (let i = 0; i < 6; i++) {
      setDice({ d1: 1 + Math.floor(Math.random() * 6), d2: 1 + Math.floor(Math.random() * 6), rolling: true });
      await delay(65);
    }
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    const total = d1 + d2;
    const hit = total >= attacker.skill;
    const defender = unitsRef.current.find((u) => u.id === defenderId);
    const dmg = hit ? Math.max(1, attacker.dmg - Math.floor((defender?.arm || 0) / 5)) : 0;
    setDice({ d1, d2, total, hit, target: attacker.skill, rolling: false });

    if (hit) {
      addLog(`${attacker.name} fires on ${defender.name} — rolled ${total} vs TN${attacker.skill}+ — HIT for ${dmg} dmg.`);
    } else {
      addLog(`${attacker.name} fires on ${defender.name} — rolled ${total} vs TN${attacker.skill}+ — MISS.`);
    }

    setUnits((prev) => {
      const next = prev.map((u) => (u.id === defenderId ? { ...u, hp: Math.max(0, u.hp - dmg) } : u));
      if (dmg > 0) {
        const target = next.find((u) => u.id === defenderId);
        if (target.hp === 0) addLog(`${target.name} is destroyed!`);
      }
      unitsRef.current = next;
      return next;
    });
    await delay(300);
    setBusy(false);
  }

  function handleHexClick(col, row) {
    if (busy || phase === "gameover") return;
    const key = `${col},${row}`;

    if (phase === "playerMove") {
      const occupant = getUnitAt(col, row);
      if (occupant && occupant.side === "player" && !occupant.moved) {
        setSelectedId(occupant.id);
        return;
      }
      if (selected && !selected.moved && movementRange.has(key) && !occupant) {
        setUnits((prev) => prev.map((u) => (u.id === selected.id ? { ...u, col, row, moved: true } : u)));
        setSelectedId(null);
        return;
      }
      setSelectedId(null);
    } else if (phase === "playerFire") {
      const occupant = getUnitAt(col, row);
      if (occupant && occupant.side === "player" && !occupant.fired) {
        setSelectedId(occupant.id);
        return;
      }
      if (selected && !selected.fired && occupant && occupant.side === "enemy" && attackable.has(key)) {
        const atk = selected;
        setUnits((prev) => prev.map((u) => (u.id === atk.id ? { ...u, fired: true } : u)));
        setSelectedId(null);
        resolveAttack(atk, occupant.id).then(() => checkWin(unitsRef.current));
        return;
      }
      setSelectedId(null);
    }
  }

  function endMovementPhase() {
    if (busy) return;
    setSelectedId(null);
    setPhase("playerFire");
    addLog("-- WEAPON PHASE --");
  }

  async function endFirePhase() {
    if (busy) return;
    setSelectedId(null);
    setPhase("enemyTurn");
    addLog("-- ENEMY PHASE --");
    await runEnemyTurn();
    if (checkWin(unitsRef.current)) return;
    setUnits((prev) => prev.map((u) => (u.side === "player" ? { ...u, moved: false, fired: false } : u)));
    setTurn((t) => t + 1);
    setPhase("playerMove");
    addLog(`-- YOUR TURN ${turn + 1}: MOVEMENT PHASE --`);
  }

  async function runEnemyTurn() {
    setBusy(true);
    const enemyIds = unitsRef.current.filter((u) => u.side === "enemy" && u.hp > 0).map((u) => u.id);
    for (const id of enemyIds) {
      const unit = unitsRef.current.find((u) => u.id === id);
      if (!unit || unit.hp <= 0) continue;
      const targets = unitsRef.current.filter((u) => u.side === "player" && u.hp > 0);
      if (!targets.length) break;
      let nearest = targets[0];
      let bestDist = Infinity;
      const uA = offsetToAxial(unit.col, unit.row);
      targets.forEach((t) => {
        const d = axialDistance(uA, offsetToAxial(t.col, t.row));
        if (d < bestDist) { bestDist = d; nearest = t; }
      });

      if (bestDist > unit.rng) {
        const range = computeMovementRange(unit, unitsRef.current, hexSet);
        let bestKey = null, bestScore = bestDist;
        range.forEach((key) => {
          const [c, r] = key.split(",").map(Number);
          const d = axialDistance(offsetToAxial(c, r), offsetToAxial(nearest.col, nearest.row));
          if (d < bestScore) { bestScore = d; bestKey = key; }
        });
        if (bestKey) {
          const [c, r] = bestKey.split(",").map(Number);
          addLog(`${unit.name} advances toward ${nearest.name}.`);
          setUnits((prev) => {
            const next = prev.map((u) => (u.id === id ? { ...u, col: c, row: r } : u));
            unitsRef.current = next;
            return next;
          });
          await delay(450);
        } else {
          addLog(`${unit.name} holds position — no clear path.`);
          await delay(250);
        }
      }

      const freshUnit = unitsRef.current.find((u) => u.id === id);
      const freshTarget = unitsRef.current.find((u) => u.id === nearest.id);
      if (freshUnit && freshTarget && freshTarget.hp > 0) {
        const d = axialDistance(offsetToAxial(freshUnit.col, freshUnit.row), offsetToAxial(freshTarget.col, freshTarget.row));
        if (d <= freshUnit.rng) {
          await resolveAttack(freshUnit, freshTarget.id);
          if (checkWin(unitsRef.current)) { setBusy(false); return; }
        }
      }
    }
    setBusy(false);
  }

  function newBattle() {
    setUnits(makeInitialUnits());
    setPhase("playerMove");
    setSelectedId(null);
    setTurn(1);
    setDice(null);
    setWinner(null);
    setLog(["BRIEFING: Cobalt Legion, hold the line against the Crimson Host.", "-- YOUR TURN 1: MOVEMENT PHASE --"]);
  }

  const phaseLabel = { playerMove: "MOVEMENT PHASE", playerFire: "WEAPON PHASE", enemyTurn: "ENEMY PHASE", gameover: "BATTLE OVER" }[phase];

  return (
    <div style={styles.app}>
      <div style={styles.banner}>
        <div style={styles.bannerTitle}>HEX WAR</div>
        <div style={styles.bannerSub}>COBALT LEGION vs CRIMSON HOST</div>
      </div>

      <div style={styles.turnBar}>
        <span style={styles.turnBadge}>TURN {turn}</span>
        <span style={{ ...styles.turnBadge, background: phase === "enemyTurn" ? COLORS.bloodPrimary : COLORS.steelPrimary }}>{phaseLabel}</span>
        <div style={{ flex: 1 }} />
        {phase === "playerMove" && (
          <button style={styles.btn} onClick={endMovementPhase} disabled={busy}>END MOVEMENT ▸</button>
        )}
        {phase === "playerFire" && (
          <button style={styles.btn} onClick={endFirePhase} disabled={busy}>END WEAPON PHASE ▸</button>
        )}
      </div>

      <div style={styles.mainRow}>
        {/* LEFT: stat card */}
        <div style={styles.sidebar}>
          <div style={styles.cardHeader}>UNIT DATASHEET</div>
          {selected ? (
            <StatCard unit={selected} />
          ) : (
            <div style={styles.emptyCard}>SELECT A UNIT ON THE FIELD</div>
          )}
          <div style={styles.diceTray}>
            <div style={styles.cardHeader}>LAST ROLL</div>
            {dice ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px" }}>
                <Die value={dice.d1} /> <Die value={dice.d2} />
                <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: COLORS.ink }}>
                  {dice.rolling ? "rolling…" : `= ${dice.d1 + dice.d2} vs TN${dice.target}+ ${dice.hit ? "HIT" : "MISS"}`}
                </div>
              </div>
            ) : (
              <div style={{ padding: "6px 4px", fontFamily: "'Share Tech Mono', monospace", fontSize: 12, color: COLORS.gunmetal }}>no rolls yet</div>
            )}
          </div>
        </div>

        {/* CENTER: battlefield */}
        <div style={styles.boardWrap}>
          <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={styles.board}>
            {HEXES.map((h) => {
              const { x, y } = hexToPixel(h.col, h.row);
              const isBlocked = BLOCKED.has(h.key);
              const isMoveTarget = movementRange.has(h.key);
              const isAtkTarget = attackable.has(h.key);
              let fill = COLORS.paper;
              if ((h.col + h.row) % 2 === 0) fill = COLORS.paperDark;
              if (isBlocked) fill = "#8a8676";
              if (isMoveTarget) fill = "#a7c08f";
              return (
                <g key={h.key} onClick={() => handleHexClick(h.col, h.row)} style={{ cursor: busy ? "default" : "pointer" }}>
                  <polygon points={hexCorners(x, y)} fill={fill} stroke={COLORS.gridLine} strokeWidth="1.3" />
                  {isBlocked && (
                    <>
                      <circle cx={x - 6} cy={y + 3} r="5" fill="#5f5c4d" stroke={COLORS.ink} strokeWidth="1" />
                      <circle cx={x + 7} cy={y - 4} r="6" fill="#726e5c" stroke={COLORS.ink} strokeWidth="1" />
                    </>
                  )}
                  {isAtkTarget && (
                    <polygon points={hexCorners(x, y)} fill="none" stroke={COLORS.atkHi} strokeWidth="3" strokeDasharray="4,3" />
                  )}
                </g>
              );
            })}
            {units.filter((u) => u.hp > 0).map((u) => {
              const { x, y } = hexToPixel(u.col, u.row);
              const isSel = u.id === selectedId;
              const dimmed = (phase === "playerMove" && u.side === "player" && u.moved) || (phase === "playerFire" && u.side === "player" && u.fired);
              return (
                <g key={u.id} transform={`translate(${x},${y})`} onClick={() => handleHexClick(u.col, u.row)} style={{ cursor: busy ? "default" : "pointer", opacity: dimmed ? 0.55 : 1 }}>
                  <ellipse cx="0" cy={SIZE * 0.55} rx={SIZE * 0.5} ry={SIZE * 0.16} fill={COLORS.ink} opacity="0.25" />
                  {isSel && <circle cx="0" cy="0" r={SIZE * 0.85} fill="none" stroke={COLORS.warn} strokeWidth="2.5" />}
                  <UnitSprite type={u.type} side={u.side} />
                  {/* health bar */}
                  <rect x={-SIZE * 0.42} y={-SIZE * 0.75} width={SIZE * 0.84} height="5" fill={COLORS.ink} />
                  <rect x={-SIZE * 0.42} y={-SIZE * 0.75} width={(SIZE * 0.84) * (u.hp / u.maxHp)} height="5" fill={u.hp / u.maxHp > 0.5 ? "#5c8a4a" : u.hp / u.maxHp > 0.25 ? COLORS.warn : COLORS.rust} />
                </g>
              );
            })}
          </svg>

          {phase === "gameover" && (
            <div style={styles.overlay}>
              <div style={{ ...styles.stamp, color: winner === "player" ? COLORS.steelPrimary : COLORS.rust, borderColor: winner === "player" ? COLORS.steelPrimary : COLORS.rust }}>
                {winner === "player" ? "VICTORY" : "DEFEAT"}
              </div>
              <button style={{ ...styles.btn, fontSize: 15, padding: "10px 22px" }} onClick={newBattle}>NEW BATTLE</button>
            </div>
          )}
        </div>

        {/* RIGHT: battle log */}
        <div style={styles.logPanel}>
          <div style={styles.cardHeader}>BATTLE LOG</div>
          <div style={styles.logBody}>
            {log.map((l, i) => <div key={i} style={styles.logLine}>&gt; {l}</div>)}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      <div style={styles.footer}>
        MOVE units in the green highlight during Movement Phase, then FIRE on dashed-outlined targets during Weapon Phase. 2d6 roll must meet or beat the unit's TN to hit.
        <button style={{ ...styles.btnSmall, marginLeft: 12 }} onClick={newBattle} disabled={busy && phase !== "gameover"}>Restart Battle</button>
      </div>
    </div>
  );
}

function StatCard({ unit }) {
  const pct = unit.hp / unit.maxHp;
  return (
    <div style={styles.statCard}>
      <div style={{ fontFamily: "'Black Ops One', sans-serif", fontSize: 15, color: unit.side === "player" ? COLORS.steelPrimary : COLORS.bloodPrimary, letterSpacing: 1 }}>
        {unit.name}
      </div>
      <div style={styles.statRow}><span>TYPE</span><span>{unit.type.toUpperCase()}</span></div>
      <div style={styles.statRow}><span>MOVE</span><span>{unit.mv} HEX</span></div>
      <div style={styles.statRow}><span>RANGE</span><span>{unit.rng} HEX</span></div>
      <div style={styles.statRow}><span>ARMOR</span><span>{unit.arm}</span></div>
      <div style={styles.statRow}><span>TO-HIT</span><span>{unit.skill}+</span></div>
      <div style={styles.statRow}><span>DAMAGE</span><span>{unit.dmg}</span></div>
      <div style={{ marginTop: 6 }}>
        <div style={{ ...styles.statRow, marginBottom: 2 }}><span>HULL</span><span>{unit.hp}/{unit.maxHp}</span></div>
        <div style={{ background: COLORS.ink, height: 8, borderRadius: 1 }}>
          <div style={{ width: `${pct * 100}%`, height: "100%", background: pct > 0.5 ? "#5c8a4a" : pct > 0.25 ? COLORS.warn : COLORS.rust }} />
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: 11, color: COLORS.gunmetal, fontFamily: "'Share Tech Mono', monospace" }}>
        {unit.moved && "moved  "}{unit.fired && "fired"}
      </div>
    </div>
  );
}

const styles = {
  app: {
    fontFamily: "'Share Tech Mono', monospace",
    background: "#3a382e",
    padding: 14,
    color: COLORS.ink,
    minHeight: 600,
    boxSizing: "border-box",
  },
  banner: {
    background: COLORS.ink,
    padding: "10px 16px",
    textAlign: "center",
    borderTop: `4px solid ${COLORS.rust}`,
    borderBottom: `4px solid ${COLORS.rust}`,
  },
  bannerTitle: { fontFamily: "'Black Ops One', sans-serif", fontSize: 26, color: "#e8dfc4", letterSpacing: 4 },
  bannerSub: { fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: COLORS.warn, letterSpacing: 3, marginTop: 2 },
  turnBar: { display: "flex", alignItems: "center", gap: 8, background: COLORS.paper, padding: "8px 12px", borderBottom: `3px solid ${COLORS.ink}`, flexWrap: "wrap" },
  turnBadge: { background: COLORS.gunmetal, color: "#efe8d4", padding: "4px 10px", fontSize: 12, letterSpacing: 1, fontWeight: "bold" },
  mainRow: { display: "flex", gap: 10, background: COLORS.paper, padding: 10, flexWrap: "wrap" },
  sidebar: { width: 200, flexShrink: 0 },
  logPanel: { width: 220, flexShrink: 0, display: "flex", flexDirection: "column" },
  cardHeader: { fontSize: 11, letterSpacing: 2, fontWeight: "bold", background: COLORS.ink, color: "#efe8d4", padding: "4px 8px", marginBottom: 4 },
  emptyCard: { border: `2px dashed ${COLORS.gunmetal}`, padding: 20, textAlign: "center", fontSize: 12, color: COLORS.gunmetal },
  statCard: { border: `2px solid ${COLORS.ink}`, background: "#eee7cf", padding: 10 },
  statRow: { display: "flex", justifyContent: "space-between", fontSize: 12, borderBottom: `1px dotted ${COLORS.gridLine}`, padding: "2px 0" },
  diceTray: { marginTop: 12 },
  boardWrap: { flex: 1, minWidth: 340, position: "relative", background: "#e5deca", border: `3px solid ${COLORS.ink}` },
  board: { width: "100%", height: "auto", display: "block" },
  logBody: { flex: 1, minHeight: 300, maxHeight: 460, overflowY: "auto", background: "#efe8d4", border: `2px solid ${COLORS.ink}`, padding: 8, fontSize: 11.5, lineHeight: 1.5 },
  logLine: { marginBottom: 3, color: "#2b2a24" },
  btn: { background: COLORS.rust, color: "#efe8d4", border: `2px solid ${COLORS.ink}`, padding: "6px 14px", fontFamily: "'Share Tech Mono', monospace", fontSize: 12, fontWeight: "bold", letterSpacing: 1, cursor: "pointer" },
  btnSmall: { background: COLORS.gunmetal, color: "#efe8d4", border: `2px solid ${COLORS.ink}`, padding: "3px 10px", fontFamily: "'Share Tech Mono', monospace", fontSize: 11, cursor: "pointer" },
  footer: { background: COLORS.ink, color: "#a99f80", fontSize: 11, padding: "8px 14px", display: "flex", alignItems: "center", flexWrap: "wrap" },
  overlay: { position: "absolute", inset: 0, background: "rgba(20,18,14,0.55)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 },
  stamp: { fontFamily: "'Black Ops One', sans-serif", fontSize: 44, letterSpacing: 4, border: "6px solid", padding: "10px 30px", transform: "rotate(-6deg)", background: "rgba(239,232,212,0.9)" },
};

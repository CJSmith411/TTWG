import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";

/* ============================================================================
   WAR ENGINE — a scale-agnostic tabletop wargame core.

   ARCHITECTURE
   The engine (WarEngine component, bottom of file) owns turn/phase state,
   selection, dice resolution, the battle log, and the datasheet UI. It knows
   NOTHING about hexes, vectors, or any specific scale of play. Everything
   scale-specific — the map, movement rules, targeting rules, unit roster,
   and stat-card fields — lives behind a small "Scale" interface:

     Scale = {
       id, label, tagline, ready,          // metadata; ready=false => stub UI
       hullLabel,                          // "HULL" / "STRUCTURE" / etc
       statFields: [{key,label,suffix?}],  // which unit fields to show, and how
       plannedFeatures: [string],          // used only when ready=false
       createInitialUnits(): Unit[],
       locationKey(unit): string,          // canonical position key for a unit
       computeMoveOptions(unit, units): Set<string>   // reachable location keys
       computeAttackOptions(unit, units): Set<string> // valid target unit ids
       applyMove(unit, key): partialFields             // merge into unit on move
       distanceUnits(a, b): number          // heuristic distance, for AI targeting
       distanceKeyToUnit(key, unit): number // for AI movement scoring
       computeHitFacing?(defender, attacker): "front"|"left"|"right"|"rear"
                                             // optional — which armor facing an
                                             // incoming hit lands on, given the
                                             // attacker's position relative to
                                             // the defender's current heading
       computeCoverBonus?(defender): number // optional — TN bonus for a
                                             // defender in terrain-based cover
                                             // (e.g. woods); 0/undefined = no cover
       evaluateMoveHazard?(unit, destKey): {tn,d1,d2,total,failed,damage,minSafe}|null
                                             // optional — a risk check for the
                                             // move that just finalized to
                                             // destKey (e.g. Grav Tank's
                                             // safe-speed check); null = no
                                             // hazard, engine applies `damage`
                                             // to the unit's front armor if failed
       resolveAttack?(attacker, defender): {d1,d2,total,hit,dmg}  // optional
                                                                    override of
                                                                    the default
                                                                    2d6-vs-skill
                                                                    resolver
       MapView: React component. Props: { units, selectedId, moveOptions,
         attackOptions, phase, busy, onCellClick({unitId, key}) }
     }

   Units share a standardized stat vocabulary so the generic AI and default
   combat resolver work for any scale: move, range, skill, dmg, hp, maxHp.
   Armor is tracked as its own depleting pool, separate from hp/maxHp
   (structure): incoming damage drains armor first, and only spills into
   structure once armor is gone. Armor is allocated in whole 10-point rows
   (a full row on a paper record sheet), a convention shared with the
   record-sheet generator.

   Armor comes in two shapes, and the engine (resolveAttack, StatCard, the
   hex-token armor bar) branches on which one a unit has:
     - a single number (armor / armorMax) — used by infantry, which don't
       get a facing split at all: a squad doesn't have a "rear armor" the
       way a vehicle does.
     - an object keyed by facing — armor / armorMax are each
       { front, left, right, rear } — used by every OTHER unit type
       (vehicles at every scale). Each facing's value is NOT a single
       number but an array of ARMOR_COLS (10) points-per-column — the same
       width as the pip grid the paper record sheets draw per facing — so a
       weapon can eventually target a specific column ("column 5") instead
       of just draining a total. Damage is applied via
       applyDamageTemplate(columns, dmg, template, targetColumn). The
       default (and currently only non-targeted) template is "scrape": one
       point at a time, always taken from whichever column CURRENTLY has
       the most remaining (first such column if there's a tie), which
       erodes the whole facing down toward an even, level profile rather
       than gouging a hole in one spot — used by every weapon except
       infantry small-arms, which use "cone" (see computeCoverBonus/
       resolveAttack) since a squad's fire genuinely does concentrate
       instead of spreading itself out. When a hit lands, the engine asks
       the active scale's computeHitFacing(defender, attacker) which of the
       four facings takes the damage, based on the attacker's position
       relative to the defender's current facing; a scale without that hook
       (or a unit with no numeric facing) just falls back to "front".
       Depleted armor on one facing does NOT spill into a neighboring
       facing — only into structure (hp), same as the single-number case.
       Note this is a deliberate simplification versus the paper record
       sheets, which also track a separate Turret location; the engine
       doesn't model turret hits independently since there's no
       hit-location table driving it.

   A scale can add extra fields (e.g. THRUST, WEAPON ARC) purely for
   display via statFields — the engine doesn't need to understand them.

   Facing/heading is tracked per-unit (unit.facing) for scales that have it,
   flagged via scale.facingMode. Ground uses "hex6" — a 0-5 index into the
   scale's 6 hex directions, auto-updated to the direction of travel on
   move, with an explicit in-place ROTATE action available in the UI.
   Aerospace is documented (not yet implemented) as "continuous" — a free
   0-359° heading tied to velocity rather than a 6-way hex facing. Facing
   now does two things: it's what computeHitFacing above uses to resolve
   per-facing armor, and it's the foundation for fore/aft/turreted weapon
   arcs, which are tagged on each weapon (see WEAPON.arc below) but not yet
   enforced by computeAttackOptions.

   Force shields are optional defensive equipment (unit.shield = { name,
   tnModifier, blocks: [damageType,...], power }) that raise the effective
   target number an attack needs, but only when the attacker's loadout
   includes a weapon whose damageType the shield blocks — see
   computeEffectiveSkill / defaultResolveAttack for the roll math, and the
   comment above computeEffectiveSkill for the aggregate-roll simplification
   (a shield triggers off ANY blocked weapon in the loadout, not a specific
   one, since attacks aren't resolved per-weapon yet). Shields draw power
   from the same budget weapons do, so they're accounted for in
   powerUsed/overdrawn like any other system.

   Movement itself comes in two systems, both landing on the same `move`
   field so computeMoveOptions/the AI never need to know which one a unit
   uses. Ground Tank and Infantry use a fixed prototype.move (or a
   hard-coded move for infantry), unchanged — including rotation, which
   still consumes the whole turn's move action immediately for every unit
   type (rotateSelected has no special-casing at all now).

   Grav Tank keeps a real Move stat (unit.baseMove) PLUS a Thrust bonus
   (unit.thrust, fixed) it can spend across TWO separate windows in the
   same turn: acceleration, chosen in any amount from 0 up to `thrust`, but
   ONLY before the unit has moved ("the start"); and deceleration, also 0
   up to whatever's left of the budget, but ONLY after the unit has moved
   ("the end"). unit.accelUsed and unit.decelUsed (both turn-scoped, reset
   with moved/fired) track how much of each has been spent — the hard
   constraint is accelUsed + decelUsed <= thrust, enforced by
   accelerateSelected/decelerateSelected before they'll apply a change.
   Acceleration directly sets this turn's move budget: `move` is always
   recomputed as baseMove + accelUsed, so incrementing/decrementing accel
   before moving lets the player dial in an exact amount rather than an
   all-or-nothing boost. Deceleration works the other end: the instant the
   unit's move finalizes, unit.postMoveBaseMove freezes what `move` was
   used (baseMove-at-turn-start + accelUsed) as a stable reference, and
   every decel press recomputes baseMove = postMoveBaseMove - decelUsed —
   recomputed fresh each time, not accumulated by repeated subtraction, so
   the player can also walk deceleration back up before ending the turn.
   Because acceleration is start-only now, there's no more "boost after an
   unboosted first move" case — movement is always a single action per
   turn (the old two-leg/legDone system is gone); deceleration never grants
   additional movement, it only shapes what baseMove becomes next turn.

   Like before, baseMove is NOT reset to the prototype's original value
   every turn — it carries forward, now shaped by both accel (pushes it up)
   and decel (pulls it back down) rather than only ever climbing. Whatever
   baseMove is when the turn ends is what next turn starts from — see the
   baseMove-updating branch in handleCellClick's playerMove handler (and
   the equivalent in runEnemyMovement for the AI, which only accelerates,
   never decelerates, as a simplification).

   How that move budget is actually SPENT differs by unit type too. Ground
   Tank/Infantry still use free BFS — click any hex within `move` steps,
   using up to that many, in any direction. Grav Tank does not: it's
   forward-only, and the FULL `move` value must be used (see
   gravTankMoveOptions) — every valid destination is the end of a path of
   EXACTLY that many forward hexes, no more, no less. It CAN change facing
   partway through (including right at the start), but only after
   gTurnRadius(move) consecutive hexes in the current direction, and that
   radius grows with move — so a bigger move (however much acceleration
   was dialed in) isn't just "go further," it's also "turn less often,"
   which is the intended tension ("faster isn't always better"). If no
   path of the exact required length avoids terrain/other units, the
   destination set is legitimately empty — the tank can't move that turn
   at all, a real consequence of "must use it all" rather than a bug.

   Adding a new scale later = implement this interface once. The engine,
   dice, log, and datasheet UI do not change.
   ============================================================================ */

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

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
  contour: "#7a6640",
};

/* pip layouts for d6 */
const PIPS = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};
function Die({ value }) {
  const cell = 7;
  return (
    <svg width="26" height="26" viewBox="0 0 26 26">
      <rect x="1" y="1" width="24" height="24" rx="3" fill="#efe8d4" stroke={COLORS.ink} strokeWidth="2" />
      {(PIPS[value] || []).map((idx) => {
        const cx = 4 + (idx % 3) * cell + cell / 2;
        const cy = 4 + Math.floor(idx / 3) * cell + cell / 2;
        return <circle key={idx} cx={cx} cy={cy} r="2.1" fill={COLORS.ink} />;
      })}
    </svg>
  );
}

/* FORCE SHIELDS — defensive equipment that raises the effective target
   number an attacker needs, but only against weapons of a damage type the
   shield is tuned to block (e.g. a shield stopping "energy" weapons does
   nothing against a kinetic slug). Carried on a Physical Unit as
   unit.shield = { name, tnModifier, blocks: [damageType,...] } — set on the
   Prototype (see WRAITH_CLASS below) and passed through by expandPrototype.
   Weapons declare their own damageType so shields have something to check
   against.

   SIMPLIFICATION: attacks are still resolved as one aggregate 2d6 roll per
   activation (see the Prototype/Physical Unit comment — dmg is a SUM across
   the whole loadout, not per-weapon), so there's no single "the weapon
   that's firing" to check a shield against. Until attacks are resolved
   per-weapon, a shield applies its tnModifier to the WHOLE attack roll if
   the attacker's loadout contains ANY weapon of a blocked damage type —
   i.e. carrying so much as one shielded-against weapon makes the whole
   coordinated attack harder to land, not just that weapon's share of it.
   This is the same kind of stand-in as applyDamageTemplate's "scrape" mode:
   correct in spirit, but due for a revisit once weapons resolve
   individually. */
/* COVER — terrain-based defense bonus, raising the effective TN an attack
   needs against a defender standing in it (woods, currently — see
   GROUND_SCALE.computeCoverBonus). Like force shields this stacks
   additively into computeEffectiveSkill, but unlike shields it's supplied
   by the active Scale rather than carried on the unit itself, since cover
   is a property of the HEX the defender happens to be standing on, not
   something the unit carries around — the same reasoning that made
   computeHitFacing a Scale hook rather than generic engine code. A scale
   without cover terrain (or without ready:true yet) just returns 0 and
   this whole system is a no-op for it. */
/* RANGE-BASED TARGETING — replaces the old flat "TN = attacker.skill
   regardless of distance" model. TN=3 at range 1 ("all but certain" — only
   a natural 2, snake eyes, misses; ~97% hit chance on 2d6), then rises by
   exactly +1 per BAND rather than +1 per hex: range 1 -> TN3, range 2-3 ->
   TN4, range 4-6 -> TN5, range 7-10 -> TN6, range 11-15 -> TN7, range
   16-21 -> TN8. Each band is one hex wider than the last (1, 2, 3, 4, 5,
   6 ranges respectively) — that widening band size is where the "second
   order" quadratic shape actually lives now, NOT in the TN itself, which
   only ever climbs by 1 at a time. (An earlier version of this had it
   backwards — TN itself growing as a triangular number, which made
   anything past range 4 nearly unhittable. This is the corrected,
   intended shape: gentle near-to-mid range, only getting properly hard at
   long range, capping at TN8 by range 21 — which happens to be exactly
   6 bands, 1+2+3+4+5+6.)

   The formula: band = the smallest k where the k-th triangular number
   (k(k+1)/2) is >= range, solved directly via the quadratic formula
   instead of a loop — band boundaries are ALWAYS exact integers here
   (8*T_k+1 is always a perfect square for a triangular number T_k), so
   there's no floating-point rounding risk at the edges between bands.
   TN = band + 2. Continues the same pattern smoothly past range 21 (band
   7 -> TN9, etc.) rather than hard-capping, since nothing in the request
   suggested targeting should become undefined beyond that range, just
   that 21 was as far as the given examples went.

   attacker.skill hasn't been discarded — every unit still has one, and it
   still matters, just not as the sole TN anymore. It's now a small
   modifier layered on top of the range curve, relative to G_SKILL_REFERENCE
   (7): a unit with skill 6 (better than reference) gets -1 TN, skill 8
   gets +1, skill 7 is neutral. This preserves the roster's existing
   relative accuracy differences without needing to rebalance every unit's
   skill number for the new system. */
const G_SKILL_REFERENCE = 7;
function gRangeTN(range) {
  const r = Math.max(1, range);
  const band = Math.ceil((Math.sqrt(8 * r + 1) - 1) / 2);
  return band + 2;
}
function computeEffectiveSkill(attacker, defender, coverBonus = 0, range = 1) {
  let skill = gRangeTN(range) + (attacker.skill - G_SKILL_REFERENCE);
  if (defender.shield) {
    const vulnerable = (attacker.weapons || []).some((w) => defender.shield.blocks.includes(w.damageType));
    if (vulnerable) skill += defender.shield.tnModifier;
  }
  return Math.max(2, skill + coverBonus); // 2 is the lowest a 2d6 roll can ever be — TN can't usefully go lower
}

/* default resolver: 2d6 vs a range-based TN (adjusted by the defender's
   force shield, if any — see computeEffectiveSkill above — and by cover,
   if the active scale supplies computeCoverBonus). Weapon damage is
   attacker.dmg for everyone EXCEPT Infantry, whose outgoing damage is
   their own CURRENT hull value instead — a full-strength squad hits hard,
   a squad that's taken losses hits proportionally weaker, no separate
   `dmg` stat involved at all (see createInitialUnits, which doesn't set
   one for infantry). Armor is a depleting pool (unit.armor /
   unit.armorMax), applied by the engine in resolveAttack() below, not a
   flat per-hit reducer. */
function defaultResolveAttack(attacker, defender, coverBonus = 0, range = 1) {
  const d1 = 1 + Math.floor(Math.random() * 6);
  const d2 = 1 + Math.floor(Math.random() * 6);
  const total = d1 + d2;
  const effectiveSkill = computeEffectiveSkill(attacker, defender, coverBonus, range);
  const hit = total >= effectiveSkill;
  const outgoingDmg = attacker.type === "infantry" ? attacker.hp : attacker.dmg;
  const dmg = hit ? outgoingDmg : 0;
  const shielded = !!(defender.shield && (attacker.weapons || []).some((w) => defender.shield.blocks.includes(w.damageType)));
  return { d1, d2, total, hit, dmg, effectiveSkill, shielded, covered: coverBonus > 0, range };
}

// The four armor facings vehicles are broken into — Turret is intentionally
// not one of them; see the ARMOR note in the architecture comment above.
const FACINGS = ["front", "left", "right", "rear"];

// Each facing's armor is stored as ARMOR_COLS columns rather than one
// pooled number — matching the width of the pip grid the paper record
// sheets already draw per facing. A facing with N armor rows starts every
// column at N points (N rows × 10 columns = N*10 total, same total as
// before this change) — see applyDamageTemplate below for why the columns
// exist: they're the seam for weapons to eventually hit a SPECIFIC column
// (or spread across several) instead of just draining a total.
const ARMOR_COLS = 10;
function makeArmorColumns(rows) {
  return new Array(ARMOR_COLS).fill(rows);
}
function sumColumns(cols) {
  return (cols || []).reduce((sum, v) => sum + v, 0);
}

/* Distributes `dmg` points across a facing's armor columns and returns the
   updated columns plus how much was actually absorbed (capped at what the
   facing had left). This is the hook weapon templates plug into.

   "scrape" is the default — used by every weapon except infantry
   small-arms (see resolveAttack) — and replaces the earlier left-to-right
   "pool" model entirely (not kept as an option; every prior pool call site
   now uses scrape, including the Grav Tank speeding-hazard damage — see
   applyMoveHazard). It applies damage ONE POINT AT A TIME, and for each
   point picks whichever column CURRENTLY holds the most remaining armor
   (the first such column, left to right, if there's a tie) and takes 1
   point from it. Rather than boring a hole in a single spot the way a
   fixed-order drain does, this erodes the whole facing down toward a
   level profile — the tallest point always gets worn down first, so armor
   damage spreads itself out across the facing in rough proportion to how
   much was already there, "scraping" rather than "drilling." Stops once
   every column is at 0 (nothing left anywhere to take).

   "cone" is the first real TARGETED template, used specifically by
   infantry small-arms fire against vehicle armor — unlike scrape, a
   squad's fire genuinely concentrates rather than spreading itself out.
   It builds a proper isosceles triangle, apex at the entry column,
   widening as it penetrates — NOT "drain the center column fully, then
   spread" (an earlier version did that, which let a single column get
   penetrated far deeper than it spread, the opposite of a real cone/blast
   pattern). It fills DEPTH LAYER BY DEPTH LAYER: layer 0 removes 1 point
   from just the center column; layer 1 removes 1 point each from
   center-1, center, and center+1; layer L removes 1 point each from the
   (2L+1) IDEAL columns spanning center±L — each full layer before
   starting the next, so the shape only ever gets wider once it's gone
   exactly that much deeper. Since half-width grows by exactly 1 column
   per depth layer (slope = 1), the two sides sit at exactly 45° from the
   center line — a true isosceles triangle with 45° leg angles, not an
   approximation of one.

   EDGE CASE — THE VOID: when the center is near either end of the array
   (column 1 or 10 in the 1-indexed display), the ideal triangle extends
   past the real armor entirely. That overhanging part is NOT redirected
   onto whatever real columns remain in range — it's lost outright, same
   as if the shot had simply missed the vehicle on that side. Concretely:
   each layer's budget consumption is based on its FULL ideal width
   (2*layer+1), even when some of those ideal positions fall outside
   [0, ARMOR_COLS-1] — so an edge-centered hit spends real damage on
   nothing, absorbing strictly less than an identically-sized hit centered
   deeper in would. (An earlier version instead only ever iterated the
   in-bounds portion of each layer, meaning an edge-centered cone just
   kept adding MORE layers — and therefore MORE total real hits — to
   compensate for the missing width, concentrating extra damage on the
   few columns near that edge instead of losing any of it. That was
   backwards from what a real cone clipped by an edge should do.) Already-
   depleted in-bounds columns (0 remaining) are treated the same way as
   the void: that ideal slot still consumes budget, it just doesn't find
   anything to absorb, since there's nothing left there either way.

   Layer visitation is still center-outward (center, center-1, center+1,
   center-2, center+2, ...) within each layer's ideal positions, so a
   partial layer (damage running out mid-layer) truncates symmetrically
   around the true center rather than favoring one side — confirmed
   against a 20,000-attack simulation after an earlier version's
   left-to-right fill order was found to systematically favor low-numbered
   columns. Perfect-square, fully-interior damage totals are unaffected by
   any of this — they still produce an exact symmetric triangle, since
   nothing falls in the void and every layer completes evenly either way. */
/* Distributes `dmg` points across a facing's armor columns. Returns
   { columns, absorbed, voided }: `absorbed` is damage that actually
   reduced a real column (subtract from dmg to get what spills to hull,
   same as always); `voided` is a SEPARATE category — damage a targeted
   pattern (currently just "cone") aimed at a position that isn't part of
   the facing at all, which is lost outright and does NOT spill to hull
   either. Physically: a cone centered near column 1 or 10 has part of its
   pattern fall off the edge of the actual armor plate into open air —
   that portion never hits the vehicle at all, armor or hull, so it just
   vanishes. This only matters for "cone" (the only template with a
   center that can sit near an edge); "scrape" has no concept of
   off-plate positions and always returns voided: 0. */
function applyDamageTemplate(columns, dmg, template = "scrape", targetColumn = null) {
  const next = [...(columns || new Array(ARMOR_COLS).fill(0))];
  let absorbed = 0;
  let voided = 0;
  if (template === "scrape") {
    let remaining = dmg;
    while (remaining > 0) {
      let bestIdx = -1, bestVal = 0;
      for (let i = 0; i < next.length; i++) {
        if (next[i] > bestVal) { bestVal = next[i]; bestIdx = i; } // strict >, so the FIRST column at the max wins ties
      }
      if (bestIdx === -1) break; // every column already at 0 — nothing left to scrape
      next[bestIdx] -= 1;
      remaining -= 1;
      absorbed += 1;
    }
  } else if (template === "cone") {
    const center = targetColumn !== null ? targetColumn : Math.floor(Math.random() * next.length);
    let budget = dmg; // theoretical remaining — shrinks by each layer's FULL ideal width every pass, whether that width lands on real armor, empty armor, or off the plate entirely
    let layer = 0;
    while (budget > 0) {
      const idealWidth = 2 * layer + 1;
      const pointsThisLayer = Math.min(budget, idealWidth);
      const idealOrder = [center]; // center-outward order over IDEAL positions, which may run off the edge
      for (let d = 1; d <= layer; d++) idealOrder.push(center - d, center + d);
      let applied = 0;
      for (const idx of idealOrder) {
        if (applied >= pointsThisLayer) break;
        if (idx < 0 || idx >= next.length) {
          voided += 1; // off the edge of the plate entirely — lost, doesn't even reach hull
        } else if (next[idx] > 0) {
          next[idx] -= 1;
          absorbed += 1;
        }
        // else: in-bounds but already-empty column — neither absorbed nor
        // voided; it still spills to hull like any other unabsorbed hit,
        // it just wasn't THIS pass's problem to account for that here.
        applied += 1;
      }
      budget -= pointsThisLayer;
      layer++;
    }
  }
  // template === "line" | "point" etc: not yet implemented.
  return { columns: next, absorbed, voided };
}

/* ============================================================================
   PROTOTYPE / PHYSICAL UNIT MODEL — vehicles only (ground, aerospace, and
   capital craft). Infantry are intentionally excluded: they stay simple,
   hard-coded stat blocks with a single fixed 10-point armor row and no
   facing split.

   A Prototype is a design-time blueprint — a vehicle CLASS, not a unit on
   the field. It specifies what the chassis can carry: armor in whole
   10-point rows PER FACING (armorRows: {front,left,right,rear}), a weapons
   loadout, and the power plant's total output (powerAvailable). It has no
   position, no crew, no current damage, and isn't deployable by itself.

   A Physical Unit is a Prototype expanded into something you can actually
   field: each facing's armor rows become a concrete column array (see
   ARMOR_COLS above), the weapons loadout's damage is summed into the
   aggregate strike damage the combat resolver uses, and power draw is
   checked against the prototype's power budget — plus the mutable
   battlefield state (id, name, side, position, current armor/hp,
   moved/fired) that only exists once a design takes the field. Two
   Physical Units can expand the same Prototype (sister vehicles built to
   the same design) and will start identical apart from name/position.
   ============================================================================ */

function expandPrototype(prototype, instance) {
  const weaponPower = prototype.weapons.reduce((sum, w) => sum + (w.power || 0), 0);
  const shieldPower = (prototype.shield && prototype.shield.power) || 0;
  const powerUsed = weaponPower + shieldPower;
  const dmg = prototype.weapons.reduce((sum, w) => sum + w.dmg, 0);
  const armorMax = {};
  const armor = {};
  FACINGS.forEach((f) => {
    armorMax[f] = makeArmorColumns(prototype.armorRows[f] || 0);
    armor[f] = makeArmorColumns(prototype.armorRows[f] || 0);
  });
  // Two movement systems: a fixed prototype.move (Ground Tank, Infantry —
  // unchanged) or prototype.move PLUS prototype.thrust (Grav Tank), where
  // thrust is a budget split between acceleration (start-only) and
  // deceleration (end-only) — see the THRUST comment above WRAITH_CLASS
  // and accelerateSelected/decelerateSelected/handleCellClick for the
  // mechanics. `move` stays the field computeMoveOptions/the AI actually
  // read either way, so nothing else in the engine needs to know which
  // system a given unit uses; for thrust units it's always
  // baseMove + accelUsed. `baseMove` starts equal to prototype.move here,
  // but it's only the STARTING point, not a permanently fixed value — it
  // carries forward turn to turn once play begins (see the architecture
  // comment above for why).
  const movementFields = typeof prototype.thrust === "number"
    ? { move: prototype.move, baseMove: prototype.move, thrust: prototype.thrust, accelUsed: 0, decelUsed: 0, postMoveBaseMove: prototype.move }
    : { move: prototype.move };
  return {
    ...instance,
    type: prototype.id,
    className: prototype.className,
    ...movementFields,
    range: prototype.range,
    skill: instance.skill ?? prototype.skill,
    dmg,
    weapons: prototype.weapons,
    shield: prototype.shield || null,
    powerAvailable: prototype.powerAvailable,
    powerUsed,
    overdrawn: powerUsed > prototype.powerAvailable,
    armorMax,
    armor,
    hp: prototype.hullPoints,
    maxHp: prototype.hullPoints,
    moved: false,
    fired: false,
  };
}

/* ============================================================================
   GROUND SCALE — hex-grid tactical combat (the original prototype), now
   implemented against the Scale interface.
   ============================================================================ */

const G_SIZE = 34;
const G_COLS = 28;
const G_ROWS = 28;
const G_VB_W = 1.5 * G_SIZE * G_COLS + G_SIZE * 1.5;
const G_VB_H = Math.sqrt(3) * G_SIZE * (G_ROWS + 1);
const G_PAD_X = G_SIZE;
const G_PAD_Y = G_SIZE * 0.9;
const G_AXIAL_DIRS = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];

// Default deployment for the 28x28 default map — a scenario with a smaller
// or larger map can supply its own start positions later; this is just the
// out-of-the-box layout. Player deploys west, enemy deploys east, spread
// across the middle rows.
const G_START = {
  p1: { col: 2, row: 5 }, p2: { col: 2, row: 19 }, p3: { col: 4, row: 14 },
  e1: { col: 25, row: 5 }, e2: { col: 25, row: 19 }, e3: { col: 23, row: 14 },
};

const G_SPRITES = {
  groundtank: [
    "........", ".DBBBBD.", "DBBBBBBD", "DBHBBHBD",
    "DBBBBBBD", "DBBBBBBD", ".DDDDDD.", "D.D..D.D",
  ],
  gravtank: [
    "........", "..DBBD..", ".DBBBBD.", "DBHBBHBD",
    ".DBBBBD.", "..DBBD..", ".DHHHHD.", "..H..H..",
  ],
  infantry: [
    "...DD...", "..DBBD..", "..DHHD..", "..DBBD.",
    ".DBBBBD.", "..D..D..", "..D..D..", ".DD..DD.",
  ],
};

function gOffsetToAxial(col, row) {
  const q = col;
  const r = row - (col - (col & 1)) / 2;
  return { q, r };
}
function gAxialToOffset(q, r) {
  const col = q;
  const row = r + (q - (q & 1)) / 2;
  return { col, row };
}
function gAxialDistance(a, b) {
  const ax = a.q, az = a.r, ay = -ax - az;
  const bx = b.q, bz = b.r, by = -bx - bz;
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz));
}
function gHexToPixel(col, row) {
  const { q, r } = gOffsetToAxial(col, row);
  const x = G_SIZE * 1.5 * q + G_PAD_X + G_SIZE / 2;
  const y = G_SIZE * Math.sqrt(3) * (r + q / 2) + G_PAD_Y + G_SIZE / 2;
  return { x, y };
}
function gHexCorners(cx, cy) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i);
    pts.push(`${cx + G_SIZE * Math.cos(ang)},${cy + G_SIZE * Math.sin(ang)}`);
  }
  return pts.join(" ");
}
const G_HEXES = (() => {
  const list = [];
  for (let col = 0; col < G_COLS; col++)
    for (let row = 0; row < G_ROWS; row++) list.push({ col, row, key: `${col},${row}` });
  return list;
})();
const G_HEXSET = new Set(G_HEXES.map((h) => h.key));

/* ---------- elevation (contour map) ----------
   Every hex has an integer height 0-6 — 0 is the flat terrain (base level)
   most of the map sits at, 6 is the highest ground on the board (when the
   map reaches that high at all — see G_RELIEF_SCALE below, not every map
   does). Generated once from a few overlaid sine waves (not random
   per-hex, which would look like static rather than terrain) so nearby
   hexes vary smoothly and the result reads as rolling hills/ridges rather
   than noise. Steep enough that adjacent hexes can differ by more than
   one level (a real cliff/escarpment, not just a gentle slope) — see
   G_CONTOURS below for how that shows up as CLUSTERED contour lines
   rather than one thicker line. Elevation now blocks line of sight for
   weapons fire — see gHasLineOfSight further down — but still doesn't
   affect movement cost (climbing a ridge costs the same as flat ground);
   that's the remaining piece if elevation should shape movement too, not
   just targeting.

   Two things are randomized once per page load (not reseeded on New
   Battle, which doesn't currently regenerate terrain):
     - G_RELIEF_SCALE (0.3-1.0): how much vertical range the terrain uses
       at all — a low roll produces a genuinely low-relief map that never
       climbs past height 2-3; a high roll can still reach the full 0-6.
     - G_ZERO_FRACTION (0.75-0.90): how much of the map sits at base level.
       Rather than a fixed base-offset constant (which would drift off
       target once relief scale also varies — a flatter relief signal
       needs a different offset to hit the same zero-percentage than a
       sharper one does), gHeightAt is calibrated by actually computing
       every hex's raw (pre-offset) value, sorting them, and picking
       G_HEIGHT_BASE so the G_ZERO_FRACTION percentile lands exactly on
       the round-to-0 boundary. This hits the target precisely (verified
       to within ~0.1%) regardless of what relief scale rolled, instead of
       hoping a hand-tuned constant happens to still work. */
const G_RELIEF_SCALE = 0.3 + Math.random() * 0.7; // ~0.3 (low, max height ~2-3) to 1.0 (full 0-6 range)
const G_ZERO_FRACTION = 0.75 + Math.random() * 0.15; // 75%-90% of the map at height 0
function gReliefRaw(col, row) {
  const { q, r } = gOffsetToAxial(col, row);
  const x = q, y = r + q / 2;
  return (
    Math.sin(x * 0.4 + 1.3) * Math.cos(y * 0.35 - 0.7) * 2.8 +
    Math.sin((x * 1.1 + y) * 0.27 + 2.1) * 2.1 +
    Math.cos((x - y * 0.6) * 0.22 - 1.5) * 1.7
  ) * G_RELIEF_SCALE;
}
const G_HEIGHT_BASE = (() => {
  const sorted = G_HEXES.map((h) => gReliefRaw(h.col, h.row)).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * G_ZERO_FRACTION));
  return 0.5 - sorted[idx];
})();
function gHeightAt(col, row) {
  return Math.max(0, Math.min(6, Math.round(gReliefRaw(col, row) + G_HEIGHT_BASE)));
}
const G_HEIGHT = new Map(G_HEXES.map((h) => [h.key, gHeightAt(h.col, h.row)]));

/* ---------- trees (light/heavy woods) ----------
   Two forest types. Three effects, each independently layered:
     - LINE OF SIGHT: both add the same +1 to sighting height only — the
       canopy blocks sightlines like extra elevation would, but the ground
       underneath doesn't actually change height, so this is applied in
       gHasLineOfSight's eye/sightline calculation, never in G_HEIGHT or
       the contour/elevation-shading system.
     - MOVEMENT: Light Woods costs +1 movement point to enter; Heavy Woods
       costs +2 — on TOP of whatever the elevation-based cost for that step
       already is (see gMoveStepCostHalf), the same additive-layers
       convention elevation cost already established, so a wooded hill
       costs more than either a bare hill or flat woods alone. (This
       additive-layers reading was a judgment call the first time this
       went in, since the original request phrased costs as flat totals
       rather than "+X" — the later "+1 and +2" phrasing confirms it was
       the right read.)
     - DEFENSE: a unit standing in woods when fired on raises the
       attacker's effective TN — Light Woods +1, Heavy Woods +2 (see
       G_TREE_DEFENSE_BONUS) — cover making it harder to hit, not harder to
       damage once hit (armor/shield still handle that separately). This is
       supplied to the generic combat resolver via GROUND_SCALE's
       computeCoverBonus hook rather than the resolver knowing about trees
       directly — see the COVER comment above computeEffectiveSkill.

   Placement uses its own noise field (gTreeRaw), NOT gReliefRaw — deliberately
   different frequencies/phases so forests don't track the hills at all
   ("need not co-locate"). Density is calibrated the same percentile way
   G_ZERO_FRACTION is: total tree coverage matches whatever fraction of the
   map ended up raised terrain (1 - G_ZERO_FRACTION), and within that
   tree-covered area, the top ~40% by local noise density becomes Heavy
   Woods (denser forest core) and the rest Light Woods (sparser fringe) —
   a natural gradient rather than a coin-flip between the two types. */
function gTreeRaw(col, row) {
  const { q, r } = gOffsetToAxial(col, row);
  const x = q, y = r + q / 2;
  return (
    Math.sin(x * 0.55 - 2.2) * Math.cos(y * 0.48 + 1.1) * 2.0 +
    Math.cos((x * 0.9 - y * 1.3) * 0.31 + 0.4) * 1.6 +
    Math.sin((x + y * 0.5) * 0.37 - 1.8) * 1.2
  );
}
const G_TREES = (() => {
  const raisedFraction = 1 - G_ZERO_FRACTION;
  const sortedRaw = G_HEXES.map((h) => gTreeRaw(h.col, h.row)).sort((a, b) => a - b);
  const treeThresholdIdx = Math.max(0, sortedRaw.length - Math.round(sortedRaw.length * raisedFraction));
  const treeThreshold = sortedRaw[Math.min(treeThresholdIdx, sortedRaw.length - 1)];
  const forested = G_HEXES.filter((h) => gTreeRaw(h.col, h.row) >= treeThreshold);
  const forestedRawSorted = forested.map((h) => gTreeRaw(h.col, h.row)).sort((a, b) => a - b);
  const heavyThreshold = forestedRawSorted[Math.floor(forestedRawSorted.length * 0.6)]; // top 40% of forested = heavy
  const trees = new Map();
  forested.forEach((h) => trees.set(h.key, gTreeRaw(h.col, h.row) >= heavyThreshold ? "heavy" : "light"));
  // Safety net, same pattern as the water generator's G_START guard:
  // deployment hexes never render as forest, however unlikely a collision is.
  Object.values(G_START).forEach((p) => trees.delete(`${p.col},${p.row}`));
  return trees;
})();
const G_TREE_MOVE_COST = { light: 1, heavy: 2 }; // real movement points, added on top of elevation cost
const G_TREE_LOS_BONUS = 1; // both types add the same +1 to sighting height
const G_TREE_DEFENSE_BONUS = { light: 1, heavy: 2 }; // TN bonus for a defender standing in woods when fired on
// Fixed small pine-icon clusters drawn per forested hex — light woods gets
// 2 trees (sparser), heavy woods gets 4 (denser), so the two read as
// visually distinct at a glance without needing a text label.
const G_TREE_ICON_OFFSETS = {
  light: [{ dx: -8, dy: 4 }, { dx: 8, dy: -2 }],
  heavy: [{ dx: -9, dy: 5 }, { dx: 9, dy: -3 }, { dx: 0, dy: -8 }, { dx: 2, dy: 6 }],
};

// Elevation shading: dark at height 0, light at height 6, linearly
// interpolated per RGB channel — replaces the old flat paper/paperDark
// checkerboard so the contour lines (drawn on top, see G_CONTOURS below)
// actually read as terrain bands instead of being hard to spot against a
// uniform fill.
const G_HEIGHT_LOW = { r: 0x8f, g: 0x82, b: 0x5a };
const G_HEIGHT_HIGH = { r: 0xf2, g: 0xec, b: 0xd6 };
function gHeightColor(h) {
  const t = h / 6;
  const r = Math.round(G_HEIGHT_LOW.r + (G_HEIGHT_HIGH.r - G_HEIGHT_LOW.r) * t);
  const g = Math.round(G_HEIGHT_LOW.g + (G_HEIGHT_HIGH.g - G_HEIGHT_LOW.g) * t);
  const b = Math.round(G_HEIGHT_LOW.b + (G_HEIGHT_HIGH.b - G_HEIGHT_LOW.b) * t);
  return `rgb(${r},${g},${b})`;
}

// Which two hex corners (by gHexCorners' 0-5 indexing) bound the edge in
// each of the 6 axial directions — derived from matching each direction's
// angle (see gFacingAngleDeg) to the midpoint angle between two corners.
const G_EDGE_CORNERS = { 0: [0, 1], 1: [5, 0], 2: [4, 5], 3: [3, 4], 4: [2, 3], 5: [1, 2] };

// Contour line segments: one per INTEGER HEIGHT LEVEL crossed by a hex
// edge, precomputed once since the height map is static. Only directions
// 0-2 are walked per hex (each edge is shared by exactly 2 hexes and
// would otherwise be found — and drawn — twice, once from each side). A
// gentle slope (neighbors differing by 1) gets a single line, same as
// before; a cliff (differing by 2, 3+) gets that many lines, offset
// perpendicular to the edge so they CLUSTER close together right on that
// edge — the real-topographic-map convention where tightly-packed contour
// lines mean steep terrain, rather than one line just drawn thicker.
const G_CONTOURS = (() => {
  const segments = [];
  const spacing = 2.4; // px between clustered lines on a multi-level edge
  G_HEXES.forEach((h) => {
    const height = G_HEIGHT.get(h.key);
    const { x, y } = gHexToPixel(h.col, h.row);
    for (let d = 0; d < 3; d++) {
      const axial = gOffsetToAxial(h.col, h.row);
      const dir = G_AXIAL_DIRS[d];
      const off = gAxialToOffset(axial.q + dir.q, axial.r + dir.r);
      const nKey = `${off.col},${off.row}`;
      if (!G_HEXSET.has(nKey)) continue;
      const nHeight = G_HEIGHT.get(nKey);
      const diff = Math.abs(nHeight - height);
      if (diff === 0) continue;
      const [c1, c2] = G_EDGE_CORNERS[d];
      const a1 = (Math.PI / 180) * (60 * c1), a2 = (Math.PI / 180) * (60 * c2);
      const p1 = { x: x + G_SIZE * Math.cos(a1), y: y + G_SIZE * Math.sin(a1) };
      const p2 = { x: x + G_SIZE * Math.cos(a2), y: y + G_SIZE * Math.sin(a2) };
      const edx = p2.x - p1.x, edy = p2.y - p1.y;
      const elen = Math.hypot(edx, edy) || 1;
      const px = -edy / elen, py = edx / elen; // unit vector perpendicular to the edge
      for (let i = 0; i < diff; i++) {
        const o = (i - (diff - 1) / 2) * spacing;
        segments.push({
          x1: p1.x + px * o, y1: p1.y + py * o,
          x2: p2.x + px * o, y2: p2.y + py * o,
        });
      }
    }
  });
  return segments;
})();

/* ---------- water (rivers + lakes) ----------
   Rivers trace a steepest-descent path from a high-ground source: at each
   hex, move to whichever on-map neighbor is STRICTLY lower; since height
   strictly decreases every step, a path is naturally bounded (at most ~6-7
   hops before hitting 0) — no cycle is possible, the loop-safety cap below
   is just a belt-and-braces guard. A path ends one of three ways: it flows
   off the map edge (a source hex has an off-map neighbor and no lower
   on-map one), it pools (no neighbor is lower at all — a local minimum —
   in which case connected same-height hexes flood-fill into a lake, capped
   at G_LAKE_MAX so a big flat lowland doesn't turn into a map-spanning
   "lake"), or it merges into a river hex some earlier source already
   traced (a tributary joining the main flow — the path stops rather than
   re-walking ground that already drains the same way).

   Sources are the map's tallest candidate peaks at or above
   G_WATER_SOURCE_HEIGHT (see G_RIVER_COUNT below for how many get picked).

   This is a visual/data layer, same as elevation and contour lines when
   they first went in — nothing yet reads G_RIVER_HEXES/G_LAKE_HEXES for
   movement cost or line-of-sight, though LOS's existing terrain-height
   check would need conscious thought before water started blocking or
   passing sightlines a particular way. Source height is relative to
   G_MAX_HEIGHT (the actual highest hex THIS map reached), not a fixed
   absolute number — G_RELIEF_SCALE means a low-relief roll might never
   climb past height 2-3, and a fixed "sources need height >= 4" threshold
   would leave a flat map with no rivers at all; "near this map's own
   peak" always leaves some high ground to source from, floored at 2 so
   "near the peak" doesn't degrade to "anywhere."

   Only 1-2 rivers total (G_RIVER_COUNT) — a handful of tributaries
   crisscrossing the whole board reads as clutter, not terrain. Sources
   are the tallest candidate peaks, picked greedily with a minimum
   separation from each other so two rivers (when there are two) start
   from genuinely different high ground rather than two summit hexes of
   the same ridge; if the map doesn't have well-separated peaks to spare,
   it's fine to end up with just 1. */
const G_MAX_HEIGHT = Math.max(...G_HEIGHT.values());
const G_WATER_SOURCE_HEIGHT = Math.max(2, G_MAX_HEIGHT - 2);
const G_LAKE_MAX = 8;
const G_RIVER_COUNT = Math.random() < 0.5 ? 1 : 2;
const { G_RIVER_PATHS, G_RIVER_HEXES, G_LAKE_HEXES } = (() => {
  const riverHexes = new Set();
  const lakeHexes = new Set();
  const paths = [];

  function floodFillLake(startCol, startRow) {
    const startHeight = G_HEIGHT.get(`${startCol},${startRow}`);
    const stack = [{ col: startCol, row: startRow }];
    const seen = new Set([`${startCol},${startRow}`]);
    let added = 0;
    while (stack.length && added < G_LAKE_MAX) {
      const cur = stack.pop();
      lakeHexes.add(`${cur.col},${cur.row}`);
      added++;
      const axial = gOffsetToAxial(cur.col, cur.row);
      G_AXIAL_DIRS.forEach((dir) => {
        if (added >= G_LAKE_MAX) return;
        const off = gAxialToOffset(axial.q + dir.q, axial.r + dir.r);
        const nKey = `${off.col},${off.row}`;
        if (!G_HEXSET.has(nKey) || seen.has(nKey)) return;
        if (G_HEIGHT.get(nKey) === startHeight) { seen.add(nKey); stack.push({ col: off.col, row: off.row }); }
      });
    }
  }

  const candidates = G_HEXES
    .filter((h) => G_HEIGHT.get(h.key) >= G_WATER_SOURCE_HEIGHT)
    .sort((a, b) => G_HEIGHT.get(b.key) - G_HEIGHT.get(a.key)); // tallest peaks first
  const sources = [];
  for (const cand of candidates) {
    if (sources.length >= G_RIVER_COUNT) break;
    const candAxial = gOffsetToAxial(cand.col, cand.row);
    const tooClose = sources.some((s) => gAxialDistance(candAxial, gOffsetToAxial(s.col, s.row)) < 6);
    if (!tooClose) sources.push(cand);
  }
  sources.forEach((src) => {
    let current = { col: src.col, row: src.row };
    let momentumDir = null; // last direction actually moved, for crossing flat ground
    const path = [];
    const localVisited = new Set();
    for (let step = 0; step < 80; step++) {
      const key = `${current.col},${current.row}`;
      path.push(current);
      if (localVisited.has(key)) break; // safety net; shouldn't trigger given monotonic height/momentum rules
      localVisited.add(key);
      if (riverHexes.has(key) && path.length > 1) break; // tributary reached an existing river — merge, stop tracing
      riverHexes.add(key);

      const axial = gOffsetToAxial(current.col, current.row);
      let bestOff = null, bestDir = null, bestHeight = G_HEIGHT.get(key);
      let hasOffMapNeighbor = false;
      G_AXIAL_DIRS.forEach((dir, dirIdx) => {
        const off = gAxialToOffset(axial.q + dir.q, axial.r + dir.r);
        const nKey = `${off.col},${off.row}`;
        if (!G_HEXSET.has(nKey)) { hasOffMapNeighbor = true; return; }
        const h = G_HEIGHT.get(nKey);
        if (h < bestHeight) { bestHeight = h; bestOff = off; bestDir = dirIdx; }
      });

      if (bestOff) {
        current = bestOff;
        momentumDir = bestDir;
        continue;
      }

      // No strictly-lower neighbor — flat ground (or a true basin). Rather
      // than pooling the instant the slope evens out, keep carrying the
      // river forward in whatever direction it was already flowing, as
      // long as that hex isn't uphill — real terrain this "flat" at hex
      // resolution still has minor variance a river would follow, we just
      // aren't modeling it at that granularity. Only a genuine dead end
      // (no momentum to fall back on, or momentum blocked by higher
      // ground) pools or exits.
      if (momentumDir !== null) {
        const dir = G_AXIAL_DIRS[momentumDir];
        const off = gAxialToOffset(axial.q + dir.q, axial.r + dir.r);
        const nKey = `${off.col},${off.row}`;
        if (G_HEXSET.has(nKey) && G_HEIGHT.get(nKey) <= G_HEIGHT.get(key)) {
          current = off; // momentum carries it straight across the flat stretch
          continue;
        }
      }
      if (!hasOffMapNeighbor) floodFillLake(current.col, current.row); // genuine local minimum — pool
      break; // either pooled or flowed off-map; path ends here either way
    }
    if (path.length > 1) paths.push(path);
  });

  // Safety net: deployment hexes should never render as water, however
  // unlikely a collision is with the current terrain parameters — cheap
  // insurance against a future tweak to gHeightAt or the river-source
  // selection shifting things.
  Object.values(G_START).forEach((p) => { riverHexes.delete(`${p.col},${p.row}`); lakeHexes.delete(`${p.col},${p.row}`); });

  return { G_RIVER_PATHS: paths, G_RIVER_HEXES: riverHexes, G_LAKE_HEXES: lakeHexes };
})();

/* ---------- facing (6-way hex heading, shared index order with G_AXIAL_DIRS) ----------
   A unit's facing is which of the 6 hex edges it's pointed toward — the same
   convention hex wargames like Battletech use. It doesn't restrict movement
   or targeting yet (weapons are still omnidirectional pending the arc work),
   but every unit carries and displays it now so fore/aft/turreted arcs can
   be layered on later without a data-model change. Facing auto-updates to
   the direction of travel on a move, and can also be set directly with the
   in-place ROTATE controls (which cost the unit's move action, same as
   relocating). */
function gFacingAngleDeg(facing) {
  const { q, r } = G_AXIAL_DIRS[((facing % 6) + 6) % 6];
  const dx = 1.5 * q;
  const dy = Math.sqrt(3) * (r + q / 2);
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}
const G_FACING_ARROWS = ["↘", "↗", "↑", "↖", "↙", "↓"]; // index-aligned with G_AXIAL_DIRS
function gNearestFacing(fromCol, fromRow, toCol, toRow) {
  const a = gHexToPixel(fromCol, fromRow);
  const b = gHexToPixel(toCol, toRow);
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return null; // didn't actually move — keep current facing
  const moveAngle = Math.atan2(dy, dx);
  let best = 0, bestDiff = Infinity;
  for (let f = 0; f < 6; f++) {
    const angle = (gFacingAngleDeg(f) * Math.PI) / 180;
    let diff = Math.abs(angle - moveAngle);
    if (diff > Math.PI) diff = 2 * Math.PI - diff;
    if (diff < bestDiff) { bestDiff = diff; best = f; }
  }
  return best;
}

/* ---------- line of sight (elevation blocking) ----------
   Weapons fire needs a clear sightline: elevated terrain strictly between
   attacker and defender can block the shot, same as real hex wargames.
   Two pieces: gHexLine walks the sequence of hexes a straight line between
   two hex centers actually passes through (cube-coordinate interpolation +
   rounding — the standard hex line-drawing algorithm, not a hand-rolled
   approximation), and gHasLineOfSight checks each hex strictly between the
   two endpoints against an interpolated "sightline height" running from
   the attacker's eye to the defender's — if any intermediate hex's terrain
   pokes above that line, the shot is blocked. G_UNIT_HEIGHT is how far a
   unit's silhouette sits above its own hex's terrain (a tunable
   abstraction, not a literal height) — it's added to both endpoints so
   units on matching elevation can still see each other over minor terrain,
   while a taller ridge in between still blocks. Adjacent/same-hex shots
   skip the check entirely (no hex can be "strictly between" two neighbors).
   This only gates GROUND attacks for now — nothing here runs for Aerospace
   or Capital, which don't have hex terrain at all yet. */
function gCubeRound(x, y, z) {
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const xDiff = Math.abs(rx - x), yDiff = Math.abs(ry - y), zDiff = Math.abs(rz - z);
  if (xDiff > yDiff && xDiff > zDiff) rx = -ry - rz;
  else if (yDiff > zDiff) ry = -rx - rz;
  else rz = -rx - ry;
  return { x: rx, y: ry, z: rz };
}
function gHexLine(fromCol, fromRow, toCol, toRow) {
  const a = gOffsetToAxial(fromCol, fromRow);
  const b = gOffsetToAxial(toCol, toRow);
  const ax = a.q, az = a.r, ay = -ax - az;
  const bx = b.q, bz = b.r, by = -bx - bz;
  const n = gAxialDistance(a, b);
  // Tiny epsilon nudge (standard hex-line-drawing fix) so a line landing
  // exactly on a hex boundary rounds consistently instead of zigzagging —
  // the three offsets still sum to zero, so they don't change which hex
  // is actually nearest, only which way exact ties break.
  const EPS = 1e-6;
  const axE = ax + EPS, ayE = ay + EPS, azE = az - 2 * EPS;
  const bxE = bx + EPS, byE = by + EPS, bzE = bz - 2 * EPS;
  const path = [];
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    const r = gCubeRound(axE + (bxE - axE) * t, ayE + (byE - ayE) * t, azE + (bzE - azE) * t);
    const off = gAxialToOffset(r.x, r.z);
    path.push({ col: off.col, row: off.row, t });
  }
  return path;
}
const G_UNIT_HEIGHT = 0.5; // how far a unit "sticks up" above its hex's terrain, for sightline purposes only
// Height used for LINE-OF-SIGHT purposes only — ground terrain plus a
// canopy bonus if the hex has any woods (light or heavy add the same
// amount). Never used for the actual elevation/contour/movement-elevation
// systems, which all still read raw G_HEIGHT; trees block sightlines
// without changing the ground underneath.
function gSightHeight(key) {
  return (G_HEIGHT.get(key) || 0) + (G_TREES.has(key) ? G_TREE_LOS_BONUS : 0);
}
function gHasLineOfSight(attacker, defender) {
  const path = gHexLine(attacker.col, attacker.row, defender.col, defender.row);
  if (path.length <= 2) return true; // adjacent or same hex — nothing can be "in between"
  const eyeA = gSightHeight(`${attacker.col},${attacker.row}`) + G_UNIT_HEIGHT;
  const eyeB = gSightHeight(`${defender.col},${defender.row}`) + G_UNIT_HEIGHT;
  for (let i = 1; i < path.length - 1; i++) {
    const key = `${path[i].col},${path[i].row}`;
    if (!G_HEXSET.has(key)) continue; // off-map guard; shouldn't occur mid-path in practice
    const terrain = gSightHeight(key);
    const sightline = eyeA + (eyeB - eyeA) * path[i].t;
    if (terrain > sightline) return false;
  }
  return true;
}

/* Which of the 4 armor facings (front/left/right/rear) an incoming hit
   lands on, given the attacker's position relative to the defender's
   current heading. Standard hex-vehicle convention: the hex direction
   directly ahead of the defender's facing is FRONT, directly behind is
   REAR, and the two hex directions flanking each side are LEFT/RIGHT —
   front and rear are each a single hexside, left and right each cover two. */
function gHitFacing(defender, attackerCol, attackerRow) {
  const dir = gNearestFacing(defender.col, defender.row, attackerCol, attackerRow);
  if (dir === null) return "front"; // shouldn't happen — attacker can't share defender's hex
  const rel = ((dir - defender.facing) % 6 + 6) % 6;
  if (rel === 0) return "front";
  if (rel === 1 || rel === 2) return "left";
  if (rel === 3) return "rear";
  return "right"; // rel 4 or 5
}

// Aggregate current/max armor across all facings (or just the flat number
// for infantry) into a single 0-1 fraction, for the compact hex-token bar
// where there isn't room to show four separate facing bars, let alone the
// individual columns within each.
function armorFraction(u) {
  if (u.armor && typeof u.armor === "object") {
    const cur = FACINGS.reduce((sum, f) => sum + sumColumns(u.armor[f]), 0);
    const max = FACINGS.reduce((sum, f) => sum + sumColumns(u.armorMax[f]), 0);
    return max > 0 ? cur / max : 0;
  }
  if (typeof u.armorMax === "number" && u.armorMax > 0) return u.armor / u.armorMax;
  return null;
}

function GUnitSprite({ type, side }) {
  const pattern = G_SPRITES[type] || G_SPRITES.infantry;
  const cell = (G_SIZE * 0.95) / 8;
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
      rects.push(<rect key={`${r}-${c}`} x={off + c * cell} y={off + r * cell} width={cell + 0.5} height={cell + 0.5} fill={map[ch]} />);
    }
  });
  return <g>{rects}</g>;
}

/* ---------- movement cost: elevation + trees ----------
   A flat hex step costs 1 movement point, same as always. Climbing costs
   +1 point per level gained; descending is discounted at HALF that rate
   (-0.5 point per level lost), floored at 0 — a steep enough drop can make
   a step free, but never net-negative (no gaining movement by going
   downhill). Woods add a flat cost ON TOP of that elevation cost to enter
   a forested hex — Light Woods +1, Heavy Woods +2 (see G_TREE_MOVE_COST) —
   the same additive-layers convention, so a wooded hill costs more than
   either a bare hill or flat woods alone. Costs are computed in
   HALF-POINTS internally (so the 0.5/level downhill rate and the whole-
   point tree costs both stay exact integer arithmetic, never floats that
   could drift) and unit.move budgets are doubled to match before any
   search runs; the unit's displayed "move" stat itself is unchanged —
   it's still N points, just spent at a variable per-hex rate depending on
   terrain. Applies uniformly to every ground-scale unit type (Ground
   Tank, Infantry, Grav Tank) — nothing here special-cases one over
   another. (Rubble/impassable terrain existed briefly and was removed
   entirely — Grav Tank had an exemption for it that no longer applies to
   anything, since trees were never covered by that exemption either.) */
function gElevationStepCostHalf(fromHeight, toHeight) {
  const diff = toHeight - fromHeight;
  if (diff > 0) return 2 + 2 * diff; // uphill: base 1 pt (2 half-pts) + 1 pt/level (2 half-pts/level)
  if (diff < 0) return Math.max(0, 2 + diff); // downhill: base 1 pt (2 half-pts) - 0.5 pt/level (1 half-pt/level), floored at 0
  return 2; // flat: base 1 point
}
function gMoveStepCostHalf(fromKey, toKey) {
  const cost = gElevationStepCostHalf(G_HEIGHT.get(fromKey) || 0, G_HEIGHT.get(toKey) || 0);
  const tree = G_TREES.get(toKey);
  return cost + (tree ? G_TREE_MOVE_COST[tree] * 2 : 0); // tree cost is whole real points -> half-points
}

/* ---------- Grav Tank safe speed ----------
   Grav Tank's absolute top speed is whatever Thrust/momentum lets it reach
   (currently as high as 75 — see WRAITH_CLASS) but terrain has its own,
   much lower "safe speed": moving faster than that through a given hex is
   still LEGAL (nothing stops the move itself), it's just risky. Four
   thresholds, most restrictive wins when more than one applies to the same
   hex (e.g. a steep, wooded hex uses whichever is lowest):
     - Clear terrain: 20
     - Light Woods: 8
     - Heavy Woods: 6
     - A step where height changes by 4 or more (either direction): 16
   Exceeding the safe speed for ANY hex along the path (not just the final
   stop — a fast tank can clip one dangerous hex partway through a longer
   route) requires a skill check: TN 7, +1 for every 2 points the tank's
   speed (unit.move — its budget for this whole action, not a per-hex
   remaining amount) is over the LOWEST safe speed found along the path.
   One check per move, not one per hazardous hex, using the worst hazard
   crossed — a scope simplification, not literal "roll separately for
   every dangerous hex," which would be its own more involved system.
   Failure damages FRONT armor specifically (spilling into hull past
   armor, same as any other hit) — the request didn't specify how much, so
   this uses 5 + however far over TN 7 the roll needed to be (a harder
   check failed means a harder impact), clearly flagged as an assumption
   rather than a given number. Ground Tank/Infantry are NOT covered by any
   of this — "speed" as a concept (and an absolute max) only exists for
   Grav Tank's thrust/momentum system. */
const G_SAFE_SPEED_CLEAR = 20;
const G_SAFE_SPEED_LIGHT_WOODS = 8;
const G_SAFE_SPEED_HEAVY_WOODS = 6;
const G_SAFE_SPEED_STEEP = 16;
function gTerrainSafeSpeed(fromKey, toKey) {
  const speeds = [G_SAFE_SPEED_CLEAR];
  if (Math.abs((G_HEIGHT.get(toKey) || 0) - (G_HEIGHT.get(fromKey) || 0)) >= 4) speeds.push(G_SAFE_SPEED_STEEP);
  const tree = G_TREES.get(toKey);
  if (tree === "light") speeds.push(G_SAFE_SPEED_LIGHT_WOODS);
  if (tree === "heavy") speeds.push(G_SAFE_SPEED_HEAVY_WOODS);
  return Math.min(...speeds);
}
// path: array of "col,row" keys as returned in gGravPathCache — evaluates
// the whole route, not just the destination. Returns null if no check was
// needed (speed never exceeded the safe speed anywhere along the path).
function evaluateSpeedHazard(unit, path) {
  if (!path || path.length < 2) return null;
  let minSafe = Infinity;
  for (let i = 1; i < path.length; i++) {
    const safe = gTerrainSafeSpeed(path[i - 1], path[i]);
    if (safe < minSafe) minSafe = safe;
  }
  if (unit.move <= minSafe) return null;
  const overage = unit.move - minSafe;
  const tn = 7 + Math.floor(overage / 2);
  const d1 = 1 + Math.floor(Math.random() * 6);
  const d2 = 1 + Math.floor(Math.random() * 6);
  const total = d1 + d2;
  const failed = total < tn;
  const damage = failed ? 5 + (tn - 7) : 0;
  return { tn, d1, d2, total, failed, damage, minSafe };
}

// How many consecutive forward hexes a Grav Tank must travel in its
// current direction before it's allowed to change facing again, as a
// function of how far it's moving this action (unit.move — whichever
// pending budget that currently is: base, start-boosted, or the leg-2
// thrust hop). Faster = a wider turning radius = fewer chances to
// redirect, which is the whole point ("faster isn't always better").
// Tunable — this divisor is a first-pass value, not a derived constant.
function gTurnRadius(move) {
  return Math.max(1, Math.ceil(move / 5));
}

/* Grav Tank movement: forward-only, and the FULL move budget must be spent
   (no "up to" — every valid destination is where a legal forward+turn path
   runs out of BOTH budget and further affordable/legal steps). The unit
   can change facing (±1 hex direction) partway through, including right
   at the start, but only after having gone gTurnRadius(unit.move)
   consecutive hexes since the last turn (or since the beginning).

   This is a real path search over (position, facing, steps-since-turn)
   states, now cost-aware: each candidate step's price comes from
   gStepCostHalf (uphill costs more, downhill costs less, both counted
   against the half-point budget), not a flat 1-hex-per-step assumption.
   A state is a valid final destination once NONE of its legal next steps
   are affordable — that's what "must use all of its movement" means once
   costs vary: exhaust the budget as far as the rules allow, not
   necessarily land on an exact remainder of 0 (which variable per-hex
   costs won't always divide evenly into anyway). If terrain or other
   units block every path from ever moving at all, the result can
   legitimately be empty — a real consequence of the rules, not a bug.

   computeMoveOptions only returns a Set<string> of destination keys per
   the Scale interface, with no room to also carry each destination's
   resulting facing (which, after a curving multi-turn path, is NOT
   generally the straight-line direction from start to end the way
   gNearestFacing assumes for other units) or the FULL PATH crossed to get
   there (needed for the safe-speed hazard check below — a fast tank can
   clip a single dangerous hex partway through a longer route, not just at
   its final stop). gGravPathCache is the pragmatic fix: a module-level
   lookup refreshed on every call here, keyed by destination, storing both
   {facing, path}, that applyMove and evaluateSpeedHazard read from for
   grav tanks instead of recomputing from a straight-line heuristic. It
   relies on computeMoveOptions always being called (and therefore
   refreshing the cache) before the corresponding applyMove for the same
   destination, which holds today since the UI recomputes moveOptions on
   every relevant state change before a click can register — but it's a
   shared-state workaround, not a clean interface, worth revisiting if
   this pattern needs to generalize beyond one unit acting at a time. */
let gGravPathCache = new Map();

function gravTankMoveOptions(unit, units) {
  gGravPathCache = new Map();
  const budgetHalf = unit.move * 2;
  if (budgetHalf <= 0) return new Set();
  const turnRadius = gTurnRadius(unit.move);

  const startKey = `${unit.col},${unit.row},${unit.facing},${turnRadius}`;
  let frontier = new Map([[startKey, { col: unit.col, row: unit.row, facing: unit.facing, stepsSinceTurn: turnRadius, cost: 0, path: [`${unit.col},${unit.row}`] }]]);
  const finalStates = new Map(); // "col,row" -> best (highest-cost) terminal state reaching it

  while (frontier.size) {
    const next = new Map();
    for (const state of frontier.values()) {
      const stateKey = `${state.col},${state.row}`;
      const canTurn = state.stepsSinceTurn >= turnRadius;
      const facingChoices = canTurn ? [state.facing, (state.facing + 1) % 6, (state.facing + 5) % 6] : [state.facing];
      let hasContinuation = false;
      for (const f of facingChoices) {
        const axial = gOffsetToAxial(state.col, state.row);
        const d = G_AXIAL_DIRS[f];
        const off = gAxialToOffset(axial.q + d.q, axial.r + d.r);
        const key = `${off.col},${off.row}`;
        if (!G_HEXSET.has(key)) continue;
        if (units.find((u) => u.hp > 0 && u.id !== unit.id && u.col === off.col && u.row === off.row)) continue;
        const stepCost = gMoveStepCostHalf(stateKey, key);
        const newCost = state.cost + stepCost;
        if (newCost > budgetHalf) continue; // can't afford this step
        hasContinuation = true;
        const turned = f !== state.facing;
        const stepsSinceTurn = Math.min(turnRadius, turned ? 1 : state.stepsSinceTurn + 1);
        const sKey = `${key},${f},${stepsSinceTurn}`;
        if (!next.has(sKey) || next.get(sKey).cost > newCost) next.set(sKey, { col: off.col, row: off.row, facing: f, stepsSinceTurn, cost: newCost, path: [...state.path, key] });
      }
      if (!hasContinuation) {
        const posKey = `${state.col},${state.row}`;
        if (!finalStates.has(posKey) || finalStates.get(posKey).cost < state.cost) finalStates.set(posKey, state);
      }
    }
    frontier = next;
  }

  const result = new Set();
  finalStates.forEach((state, key) => {
    result.add(key);
    gGravPathCache.set(key, { facing: state.facing, path: state.path });
  });
  return result;
}

function groundComputeMoveOptions(unit, units) {
  if (typeof unit.thrust === "number") return gravTankMoveOptions(unit, units);
  const budgetHalf = unit.move * 2;
  const startKey = `${unit.col},${unit.row}`;
  const costSoFar = new Map([[startKey, 0]]);
  let frontier = [{ col: unit.col, row: unit.row, cost: 0 }];
  while (frontier.length) {
    const next = [];
    for (const cell of frontier) {
      const cellKey = `${cell.col},${cell.row}`;
      const axial = gOffsetToAxial(cell.col, cell.row);
      for (const d of G_AXIAL_DIRS) {
        const off = gAxialToOffset(axial.q + d.q, axial.r + d.r);
        const key = `${off.col},${off.row}`;
        if (!G_HEXSET.has(key)) continue;
        if (units.find((u) => u.hp > 0 && u.col === off.col && u.row === off.row)) continue;
        const stepCost = gMoveStepCostHalf(cellKey, key);
        const newCost = cell.cost + stepCost;
        if (newCost > budgetHalf) continue;
        if (costSoFar.has(key) && costSoFar.get(key) <= newCost) continue; // already reached at least as cheaply
        costSoFar.set(key, newCost);
        next.push({ col: off.col, row: off.row, cost: newCost });
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  costSoFar.delete(startKey);
  const result = new Set(costSoFar.keys());

  // Guaranteed minimum mobility: this function only ever runs for Ground
  // Tank/Infantry (Grav Tank is dispatched away at the top), and a unit
  // of either type can always scramble into an immediately adjacent hex
  // regardless of remaining point budget — even a unit with 0 movement
  // left (or terrain too expensive to normally afford) can still take
  // this one step — UNLESS the height change is 4 or more, a cliff too
  // steep to just scramble up or down no matter how determined. This can
  // add destinations the cost search above wouldn't have reached at all.
  // It doesn't grant anything extra beyond that single hex though: Ground
  // Tank/Infantry already only ever get one move-click per turn (unlike
  // Grav Tank's accel/decel/leg system, there's no partial-movement state
  // to exploit here), so using this exception is automatically "the only
  // move that unit is allowed this turn" — the existing single-action
  // architecture already guarantees it without needing extra bookkeeping.
  const startHeight = G_HEIGHT.get(startKey) || 0;
  const startAxial = gOffsetToAxial(unit.col, unit.row);
  G_AXIAL_DIRS.forEach((d) => {
    const off = gAxialToOffset(startAxial.q + d.q, startAxial.r + d.r);
    const key = `${off.col},${off.row}`;
    if (!G_HEXSET.has(key) || result.has(key)) return;
    if (units.find((u) => u.hp > 0 && u.col === off.col && u.row === off.row)) return;
    if (Math.abs((G_HEIGHT.get(key) || 0) - startHeight) >= 4) return; // too steep even for this exception
    result.add(key);
  });

  return result;
}

function GroundMapView({ units, selectedId, moveOptions, attackOptions, phase, busy, onCellClick }) {
  const getUnitAt = (col, row) => units.find((u) => u.hp > 0 && u.col === col && u.row === row);
  return (
    <svg viewBox={`0 0 ${G_VB_W} ${G_VB_H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {G_HEXES.map((h) => {
        const { x, y } = gHexToPixel(h.col, h.row);
        const isMoveTarget = moveOptions.has(h.key);
        const isLake = G_LAKE_HEXES.has(h.key);
        const treeType = G_TREES.get(h.key);
        const height = G_HEIGHT.get(h.key);
        let fill = gHeightColor(height);
        if (isMoveTarget) fill = "#a7c08f";
        const occ = getUnitAt(h.col, h.row);
        return (
          <g key={h.key} onClick={() => !busy && onCellClick({ unitId: occ?.id, key: h.key })} style={{ cursor: busy ? "default" : "pointer" }}>
            <polygon points={gHexCorners(x, y)} fill={fill} stroke={COLORS.gridLine} strokeWidth="1.3" />
            {isLake && !isMoveTarget && (
              <polygon points={gHexCorners(x, y)} fill="#3a6ea5" opacity="0.55" />
            )}
            {treeType && (G_TREE_ICON_OFFSETS[treeType]).map((o, i) => (
              <polygon
                key={i}
                points={`${x + o.dx},${y + o.dy - 6} ${x + o.dx - 5},${y + o.dy + 4} ${x + o.dx + 5},${y + o.dy + 4}`}
                fill={treeType === "heavy" ? "#3d5a30" : "#5a7a4a"}
                stroke={COLORS.ink}
                strokeWidth="0.6"
              />
            ))}
            {/* elevation number — small and muted so it reads as map texture
                rather than clutter; naturally covered by a unit token when
                one occupies the hex, since units render in a later pass.
                Text color flips between dark/light so it stays legible
                against the whole gHeightColor gradient, not just one end. */}
            <text x={x} y={y + 3} textAnchor="middle" fontSize="9" fontFamily="'Share Tech Mono', monospace" fill={height >= 3 ? COLORS.ink : "#f2ecd6"} opacity="0.55">
              {height}
            </text>
            {occ && occ.side === "enemy" && attackOptions.has(occ.id) && (
              <polygon points={gHexCorners(x, y)} fill="none" stroke={COLORS.rust} strokeWidth="3" strokeDasharray="4,3" />
            )}
          </g>
        );
      })}
      {/* contour lines — one per integer height level crossed by a hex
          edge, precomputed once in G_CONTOURS since the height map is
          static; steep terrain produces several parallel lines clustered
          on the same edge rather than one thicker line, so they're all
          drawn at the same uniform width */}
      <g>
        {G_CONTOURS.map((seg, i) => (
          <line key={i} x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} stroke={COLORS.contour} strokeWidth="1.2" strokeLinecap="round" opacity="0.75" />
        ))}
      </g>
      {/* rivers — a connected polyline per traced flow path (see
          G_RIVER_PATHS), drawn as a darker base stroke with a thinner,
          lighter centerline on top for a bit of "flowing water" sheen */}
      <g>
        {G_RIVER_PATHS.map((path, i) => {
          const points = path.map((p) => gHexToPixel(p.col, p.row));
          const d = points.map((p, j) => `${j === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
          return (
            <g key={i}>
              <path d={d} fill="none" stroke="#2f5a8a" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
              <path d={d} fill="none" stroke="#8fc1e8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
            </g>
          );
        })}
      </g>
      {units.filter((u) => u.hp > 0).map((u) => {
        const { x, y } = gHexToPixel(u.col, u.row);
        const isSel = u.id === selectedId;
        const dimmed = (phase === "playerMove" && u.side === "player" && u.moved) || (phase === "playerFire" && u.side === "player" && u.fired);
        return (
          <g key={u.id} transform={`translate(${x},${y})`} onClick={() => !busy && onCellClick({ unitId: u.id, key: `${u.col},${u.row}` })} style={{ cursor: busy ? "default" : "pointer", opacity: dimmed ? 0.55 : 1 }}>
            <ellipse cx="0" cy={G_SIZE * 0.55} rx={G_SIZE * 0.5} ry={G_SIZE * 0.16} fill={COLORS.ink} opacity="0.25" />
            {isSel && <circle cx="0" cy="0" r={G_SIZE * 0.85} fill="none" stroke={COLORS.warn} strokeWidth="2.5" />}
            {typeof u.facing === "number" && (
              <g transform={`rotate(${gFacingAngleDeg(u.facing)})`}>
                <polygon points={`${G_SIZE * 0.66},0 ${G_SIZE * 0.46},${-G_SIZE * 0.13} ${G_SIZE * 0.46},${G_SIZE * 0.13}`} fill={COLORS.warn} stroke={COLORS.ink} strokeWidth="1" />
              </g>
            )}
            <GUnitSprite type={u.type} side={u.side} />
            {armorFraction(u) !== null && (
              <>
                <rect x={-G_SIZE * 0.42} y={-G_SIZE * 0.83} width={G_SIZE * 0.84} height="4" fill={COLORS.ink} />
                <rect x={-G_SIZE * 0.42} y={-G_SIZE * 0.83} width={(G_SIZE * 0.84) * armorFraction(u)} height="4" fill={COLORS.steelHi} />
              </>
            )}
            <rect x={-G_SIZE * 0.42} y={-G_SIZE * 0.75} width={G_SIZE * 0.84} height="5" fill={COLORS.ink} />
            <rect x={-G_SIZE * 0.42} y={-G_SIZE * 0.75} width={(G_SIZE * 0.84) * (u.hp / u.maxHp)} height="5" fill={u.hp / u.maxHp > 0.5 ? "#5c8a4a" : u.hp / u.maxHp > 0.25 ? COLORS.warn : COLORS.rust} />
          </g>
        );
      })}
    </svg>
  );
}

const GROUND_SCALE = {
  id: "ground",
  label: "GROUND ASSAULT",
  tagline: "Infantry squads and armor contest a hex battlefield, hex by hex.",
  ready: true,
  hullLabel: "HULL",
  armorLabel: "ARMOR",
  armorRowsMax: 10, // 1 row = 10 armor points; up to 10 rows (100 pts) per facing
  facingMode: "hex6", // unit.facing is an index 0-5 into G_AXIAL_DIRS (hex-edge heading)
  statFields: [
    { key: "move", label: "MOVE", suffix: " HEX" },
    { key: "range", label: "RANGE", suffix: " HEX" },
    { key: "skill", label: "GUNNERY" },
    { key: "dmg", label: "DAMAGE" },
    { key: "powerLine", label: "POWER" },
  ],
  createInitialUnits() {
    // Prototypes: vehicle-class blueprints (armor rows, weapons, power budget).
    // Each side fields its own chassis design, expanded below into Physical Units.
    // Weapons are tagged with a firing arc (fore / aft / turreted) relative to
    // the vehicle's facing now, ahead of arc-restricted targeting — for now
    // computeAttackOptions below still treats every weapon as omnidirectional;
    // arc is data-only until targeting is refined to check it.
    // armorRows is per facing now (front/left/right/rear); totals below match
    // what each chassis carried before the facing split, just redistributed
    // front-heavy/rear-light rather than pooled into one number.
    // Weapons also carry a damageType now ("kinetic" for every weapon below)
    // so force shields (see WRAITH_CLASS) have something to check against —
    // none of today's weapons are "energy", so the Wraith/Specter shields
    // won't visibly trigger until an energy weapon exists somewhere in the
    // roster; the mechanic is fully wired, just not yet exercised by play.
    const WRAITH_CLASS = {
      id: "gravtank", className: "Wraith-Class Grav Tank",
      // MOVE + THRUST: grav tanks have a base Move (0) plus a Thrust budget
      // (5) split between acceleration — chosen in any amount 0-5, but
      // ONLY before moving — and deceleration — also 0 up to whatever's
      // left of the budget, but ONLY after moving. accelUsed+decelUsed can
      // never exceed `thrust`. With base Move at 0, SOME acceleration is
      // mandatory just to move at all this chassis — a natural consequence
      // of the numbers below, not special-cased in the movement code. See
      // accelerateSelected/decelerateSelected and the baseMove-updating
      // branch in handleCellClick. Rotation is NOT part of this
      // restriction — it works exactly like Ground Tank/Infantry,
      // consuming the whole turn's action immediately.
      // DEV TESTING: base Move reduced to 0, Thrust bonus reduced to +5
      // (was 45 move + 30 thrust = 75 max) — every other stat below is
      // untouched from its prior value.
      move: 0, thrust: 5,
      range: 3, skill: 7,
      // DEV TESTING: bumped from the original {2,1,1,0} rows (avg 10 pts/facing)
      // to average 75 pts/facing (280-320 total range requested) so skimmers
      // survive more rounds during testing. This also drops the original
      // "zero rear armor" flavor (a deliberate tactical weak point) since
      // that's counterproductive while testing — revisit both numbers
      // together before treating these as real balance values.
      armorRows: { front: 9, left: 7, right: 7, rear: 7 }, hullPoints: 10, powerAvailable: 6,
      // Force shield: raises the attacker's effective TN by 2 against any
      // attack that includes an "energy" weapon — see computeEffectiveSkill.
      // Costs 2 power, on top of the 4 the weapons draw — exactly fills the
      // Wraith's 6-power budget.
      shield: { name: "Deflector Screen", tnModifier: 2, blocks: ["energy"], power: 2 },
      weapons: [
        { name: "Light Autocannon", dmg: 2, power: 3, arc: "turreted", damageType: "kinetic" },
        { name: "Twin Machine Guns", dmg: 1, power: 1, arc: "fore", damageType: "kinetic" },
      ],
    };
    const RHINO_CLASS = {
      id: "groundtank", className: "Rhino-Class Ground Tank",
      move: 2, range: 4, skill: 8, armorRows: { front: 3, left: 1, right: 1, rear: 1 }, hullPoints: 16, powerAvailable: 8,
      weapons: [
        { name: "Medium Autocannon", dmg: 3, power: 5, arc: "turreted", damageType: "kinetic" },
        { name: "Machine Gun", dmg: 1, power: 1, arc: "fore", damageType: "kinetic" },
      ],
    };
    const BASILISK_CLASS = {
      id: "groundtank", className: "Basilisk-Class Ground Tank",
      move: 2, range: 4, skill: 8, armorRows: { front: 2, left: 1, right: 1, rear: 1 }, hullPoints: 15, powerAvailable: 6,
      weapons: [
        { name: "Light Autocannon", dmg: 2, power: 3, arc: "turreted", damageType: "kinetic" },
        { name: "Twin Machine Guns", dmg: 2, power: 2, arc: "fore", damageType: "kinetic" },
      ],
    };

    const vehicles = [
      expandPrototype(WRAITH_CLASS, { id: "p1", side: "player", name: "WRAITH SKIMMER", ...G_START.p1, facing: 0 }),
      expandPrototype(RHINO_CLASS, { id: "p2", side: "player", name: "RHINO TANK", ...G_START.p2, facing: 0 }),
      expandPrototype(WRAITH_CLASS, { id: "e1", side: "enemy", name: "SPECTER SKIMMER", ...G_START.e1, facing: 3 }),
      expandPrototype(BASILISK_CLASS, { id: "e2", side: "enemy", name: "BASILISK", ...G_START.e2, facing: 3 }),
    ];
    // add a display-friendly "used/available" power readout for the datasheet
    vehicles.forEach((v) => { v.powerLine = `${v.powerUsed}/${v.powerAvailable}`; });

    // Infantry squads are excluded from the Prototype/Physical Unit model for
    // ARMOR purposes (hard-set to a single 10-point row, no armor facings, no
    // weapons/power loadout) — but they still carry a heading facing like any
    // other ground unit; a squad can face a direction even without a hull.
    // No `dmg` stat either — see defaultResolveAttack, their outgoing
    // damage is their own current hp instead, so it's intentionally absent
    // here rather than set and then ignored.
    const infantry = [
      { id: "p3", side: "player", type: "infantry", name: "TROOPER SQD", move: 3, range: 6, armorMax: 10, armor: 10, skill: 6, hp: 8, maxHp: 8, ...G_START.p3, facing: 0, moved: false, fired: false },
      { id: "e3", side: "enemy", type: "infantry", name: "BLOOD SQD", move: 3, range: 6, armorMax: 10, armor: 10, skill: 6, hp: 8, maxHp: 8, ...G_START.e3, facing: 3, moved: false, fired: false },
    ];

    return [...vehicles, ...infantry];
  },
  locationKey(unit) {
    return `${unit.col},${unit.row}`;
  },
  computeMoveOptions: groundComputeMoveOptions,
  computeAttackOptions(unit, units) {
    const s = new Set();
    const a = gOffsetToAxial(unit.col, unit.row);
    units.filter((u) => u.side !== unit.side && u.hp > 0).forEach((u) => {
      const b = gOffsetToAxial(u.col, u.row);
      if (gAxialDistance(a, b) <= unit.range && gHasLineOfSight(unit, u)) s.add(u.id);
    });
    return s;
  },
  applyMove(unit, key) {
    const [col, row] = key.split(",").map(Number);
    if (typeof unit.thrust === "number" && gGravPathCache.has(key)) {
      // Grav tanks: use the actual facing the path search arrived with —
      // NOT gNearestFacing's straight-line heuristic, which would be wrong
      // for any path that turned partway through (see gravTankMoveOptions).
      return { col, row, facing: gGravPathCache.get(key).facing };
    }
    const newFacing = gNearestFacing(unit.col, unit.row, col, row);
    return { col, row, facing: newFacing !== null ? newFacing : unit.facing };
  },
  distanceUnits(a, b) {
    return gAxialDistance(gOffsetToAxial(a.col, a.row), gOffsetToAxial(b.col, b.row));
  },
  distanceKeyToUnit(key, unit) {
    const [col, row] = key.split(",").map(Number);
    return gAxialDistance(gOffsetToAxial(col, row), gOffsetToAxial(unit.col, unit.row));
  },
  computeHitFacing(defender, attacker) {
    if (typeof defender.facing !== "number") return "front";
    return gHitFacing(defender, attacker.col, attacker.row);
  },
  computeCoverBonus(defender) {
    const tree = G_TREES.get(`${defender.col},${defender.row}`);
    return tree ? G_TREE_DEFENSE_BONUS[tree] : 0;
  },
  // Safe-speed hazard check — only Grav Tank has a "speed" concept, so this
  // is a no-op for Ground Tank/Infantry. destKey must be a destination this
  // unit's own computeMoveOptions call just returned (so gGravPathCache
  // still has the matching path cached) — see the gGravPathCache comment
  // above gravTankMoveOptions for why this relies on call ordering.
  evaluateMoveHazard(unit, destKey) {
    if (typeof unit.thrust !== "number") return null;
    const cached = gGravPathCache.get(destKey);
    if (!cached) return null;
    return evaluateSpeedHazard(unit, cached.path);
  },
  MapView: GroundMapView,
};

/* ============================================================================
   AEROSPACE SCALE — stub. Implements only metadata; MapView renders a
   design preview instead of a playable board. Fill in the Scale interface
   (computeMoveOptions as vector/heading movement, computeAttackOptions using
   weapon arcs + altitude, etc.) to bring it online.
   ============================================================================ */

const AEROSPACE_SCALE = {
  id: "aerospace",
  label: "AEROSPACE",
  tagline: "Atmospheric and orbital dogfights — velocity and heading replace simple hex movement.",
  ready: false,
  hullLabel: "STRUCTURE",
  armorLabel: "ARMOR",
  armorRowsMax: 10, // 1 row = 10 armor points; up to 10 rows (100 pts) per facing, same as Ground
  facingMode: "continuous", // unlike Ground's 6-way hex facing, heading is a free 0-359° value tied to velocity
  statFields: [
    { key: "thrust", label: "THRUST" },
    { key: "velocity", label: "VELOCITY" },
    { key: "heading", label: "HEADING", suffix: "\u00b0" },
    { key: "altBand", label: "ALT. BAND" },
    { key: "armFore", label: "ARMOR (FORE)" },
    { key: "armAft", label: "ARMOR (AFT)" },
    { key: "skill", label: "PILOT SKILL", suffix: "+" },
  ],
  plannedFeatures: [
    "Vector movement: heading + velocity carry over turn to turn, not point-and-click hexes",
    "Altitude bands (low / high / orbital) gate which units can even engage",
    "Facing-based weapon arcs instead of omnidirectional range circles — craft heading (continuous, not Ground's 6-way hex facing) determines which fore/aft-tagged weapons can bear",
    "Stall and critical-damage effects tied to maneuver rolls",
    "Armor allocated in whole 10-point rows, up to 10 rows per facing (matches Ground)",
    "Craft built from a Prototype (armor rows, weapon loadout, power budget) expanded into a Physical Unit for the battlefield — same model as Ground",
    "28x28 default play area (matches Ground) — larger or smaller maps selectable per scenario",
  ],
  createInitialUnits() { return []; },
};

/* ============================================================================
   CAPITAL SCALE — stub. See AEROSPACE_SCALE comment; same pattern applies,
   plus critical-hit-by-location tables in place of a flat hull bar.
   ============================================================================ */

const CAPITAL_SCALE = {
  id: "capital",
  label: "CAPITAL FLEET",
  tagline: "Interstellar fleet actions — capital ships trade broadsides across a vector plot measured in hundreds of kilometers.",
  ready: false,
  hullLabel: "STRUCTURE",
  armorLabel: "ARMOR",
  armorRowsMax: 20, // 1 row = 10 armor points; up to 20 rows (200 pts) per facing — capital ships run heavier than Ground/Aerospace
  statFields: [
    { key: "thrust", label: "THRUST" },
    { key: "armFore", label: "ARMOR (FORE)" },
    { key: "armBroad", label: "ARMOR (BROADSIDE)" },
    { key: "armAft", label: "ARMOR (AFT)" },
    { key: "bays", label: "WEAPON BAYS" },
    { key: "crew", label: "CREW QUALITY", suffix: "+" },
  ],
  plannedFeatures: [
    "Open Newtonian vector-movement plot in place of a bounded hex map",
    "Fore / aft / broadside weapon bays, each with its own firing arc",
    "Location-based critical-hit tables (engines, bays, bridge) instead of a flat hull bar",
    "Capital-scale weapon ranges that span multiple movement turns",
    "Armor allocated in whole 10-point rows, up to 20 rows per facing — double Ground/Aerospace's cap",
    "Ships built from a Prototype (armor rows, weapon bays, reactor power budget) expanded into a Physical Unit for the battlefield — same model as Ground",
    "Default plot area sized to match a 28x28 grid (same default footprint as Ground/Aerospace), even though it isn't hex-subdivided — larger or smaller per scenario",
  ],
  createInitialUnits() { return []; },
};

const SCALES = [GROUND_SCALE, AEROSPACE_SCALE, CAPITAL_SCALE];

/* ============================================================================
   ENGINE — scale-agnostic turn/phase/dice/log/UI shell.
   ============================================================================ */

export default function WarEngine() {
  const [scaleId, setScaleId] = useState("ground");
  const activeScale = SCALES.find((s) => s.id === scaleId);

  const [units, setUnits] = useState(() => GROUND_SCALE.createInitialUnits());
  const [phase, setPhase] = useState("playerMove");
  const [selectedId, setSelectedId] = useState(null);
  const [scoutedId, setScoutedId] = useState(null); // enemy unit the player has clicked on to view limited recon data
  const [turn, setTurn] = useState(1);
  const [log, setLog] = useState(["BRIEFING: United Sovereign Planets, hold the line against the Terrain Socialist Republic.", "-- YOUR TURN 1: MOVEMENT PHASE --"]);
  const [dice, setDice] = useState(null);
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
    return () => document.head.removeChild(link);
  }, []);

  const addLog = useCallback((msg) => setLog((l) => [...l, msg]), []);

  function switchScale(id) {
    const next = SCALES.find((s) => s.id === id);
    setScaleId(id);
    setUnits(next.createInitialUnits());
    setPhase("playerMove");
    setSelectedId(null);
    setScoutedId(null);
    setTurn(1);
    setDice(null);
    setWinner(null);
    setLog(next.ready
      ? ["BRIEFING: United Sovereign Planets, hold the line against the Terrain Socialist Republic.", "-- YOUR TURN 1: MOVEMENT PHASE --"]
      : [`${next.label} is still in development — see the design preview.`]);
  }

  const selected = units.find((u) => u.id === selectedId) || null;
  const scouted = units.find((u) => u.id === scoutedId && u.hp > 0) || null;

  const moveOptions = useMemo(() => {
    if (!activeScale.ready || !selected || phase !== "playerMove" || selected.moved) return new Set();
    return activeScale.computeMoveOptions(selected, units);
  }, [activeScale, selected, units, phase]);

  const attackOptions = useMemo(() => {
    if (!activeScale.ready || !selected || phase !== "playerFire" || selected.fired) return new Set();
    return activeScale.computeAttackOptions(selected, units);
  }, [activeScale, selected, units, phase]);

  function getUnitAtKey(key, us = units) {
    return us.find((u) => u.hp > 0 && activeScale.locationKey(u) === key);
  }

  function checkWin(us) {
    const playersAlive = us.some((u) => u.side === "player" && u.hp > 0);
    const enemiesAlive = us.some((u) => u.side === "enemy" && u.hp > 0);
    if (!playersAlive) { setWinner("enemy"); setPhase("gameover"); addLog("*** ALL UNITED SOVEREIGN PLANETS UNITS DESTROYED — DEFEAT ***"); return true; }
    if (!enemiesAlive) { setWinner("player"); setPhase("gameover"); addLog("*** TERRAIN SOCIALIST REPUBLIC ELIMINATED — VICTORY ***"); return true; }
    return false;
  }

  // Applies the result of a scale-provided evaluateMoveHazard check (see
  // GROUND_SCALE.evaluateMoveHazard / evaluateSpeedHazard) — logs the roll
  // either way, and on a failure drains the unit's FRONT armor specifically
  // (spilling into hull past whatever armor absorbs, same rule as any other
  // hit) rather than picking a facing via computeHitFacing, since this
  // isn't an incoming attack with a direction — it's the vehicle's own
  // momentum working against it, and front is where that impact lands.
  function applyMoveHazard(unitId, unitName, hazard) {
    if (!hazard) return;
    if (!hazard.failed) {
      addLog(`${unitName} pushes past safe speed (rolled ${hazard.total} vs TN${hazard.tn}+) — holds together.`);
      return;
    }
    addLog(`${unitName} pushes past safe speed (rolled ${hazard.total} vs TN${hazard.tn}+) — FAILED, ${hazard.damage} dmg to front armor!`);
    setUnits((prev) => {
      const next = prev.map((u) => {
        if (u.id !== unitId || !u.armor || typeof u.armor !== "object" || !u.armor.front) return u;
        const applied = applyDamageTemplate(u.armor.front, hazard.damage, "scrape");
        const spill = Math.max(0, hazard.damage - applied.absorbed);
        return { ...u, armor: { ...u.armor, front: applied.columns }, hp: Math.max(0, u.hp - spill) };
      });
      unitsRef.current = next;
      return next;
    });
  }

  async function resolveAttack(attacker, defenderId) {
    setBusy(true);
    for (let i = 0; i < 6; i++) {
      setDice({ d1: 1 + Math.floor(Math.random() * 6), d2: 1 + Math.floor(Math.random() * 6), rolling: true });
      await delay(65);
    }
    const defenderSnapshot = unitsRef.current.find((u) => u.id === defenderId);
    const coverBonus = (activeScale.computeCoverBonus && activeScale.computeCoverBonus(defenderSnapshot)) || 0;
    // distanceUnits is already a required part of every Scale (the AI uses
    // it for targeting), so this reuses it rather than needing yet another
    // hook just to learn how far apart attacker and defender are.
    const range = activeScale.distanceUnits(attacker, defenderSnapshot);
    const resolver = activeScale.resolveAttack || defaultResolveAttack;
    const result = resolver(attacker, defenderSnapshot, coverBonus, range);
    const tn = result.effectiveSkill ?? attacker.skill;
    setDice({ d1: result.d1, d2: result.d2, total: result.total, hit: result.hit, target: tn, rolling: false });

    const isFlatArmor = typeof defenderSnapshot.armor === "number";
    const isFacingArmor = defenderSnapshot.armor && typeof defenderSnapshot.armor === "object";
    let hitFacing = null;
    let armorAbsorbed = 0;
    let voidedDmg = 0;
    let newFacingColumns = null;
    if (isFlatArmor) {
      armorAbsorbed = Math.min(defenderSnapshot.armor, result.dmg);
    } else if (isFacingArmor) {
      hitFacing = (activeScale.computeHitFacing && activeScale.computeHitFacing(defenderSnapshot, attacker)) || "front";
      // Infantry small-arms fire against vehicle armor uses "cone" (a
      // random column within the hit facing takes the brunt, tapering
      // outward — see applyDamageTemplate); everything else uses "scrape"
      // (erodes whichever column currently has the most remaining) until
      // other weapons carry their own template data.
      const template = attacker.type === "infantry" ? "cone" : "scrape";
      const applied = applyDamageTemplate(defenderSnapshot.armor[hitFacing], result.dmg, template);
      newFacingColumns = applied.columns;
      armorAbsorbed = applied.absorbed;
      voidedDmg = applied.voided; // a cone centered near a plate edge can lose part of its pattern off the side entirely — see applyDamageTemplate
    }
    const hasArmor = isFlatArmor || isFacingArmor;
    const hullDmg = result.dmg - armorAbsorbed - voidedDmg;
    const facingTag = hitFacing ? ` ${hitFacing.toUpperCase()}` : "";
    const shieldTag = result.shielded ? ` [${defenderSnapshot.shield.name} +${defenderSnapshot.shield.tnModifier} TN]` : "";
    const coverTag = result.covered ? ` [cover +${coverBonus} TN]` : "";
    const rangeTag = typeof result.range === "number" ? ` (range ${result.range})` : "";
    const voidTag = voidedDmg > 0 ? ` (${voidedDmg} dmg lost off the edge of the plate)` : "";

    if (result.hit) {
      if (hasArmor && hullDmg > 0) addLog(`${attacker.name} fires on ${defenderSnapshot.name}${rangeTag} — rolled ${result.total} vs TN${tn}+${shieldTag}${coverTag} — HIT on${facingTag} for ${result.dmg} dmg (${armorAbsorbed} armor, ${hullDmg} hull!)${voidTag}.`);
      else addLog(`${attacker.name} fires on ${defenderSnapshot.name}${rangeTag} — rolled ${result.total} vs TN${tn}+${shieldTag}${coverTag} — HIT on${facingTag} for ${result.dmg} dmg${hasArmor ? ", absorbed by armor." : "."}${voidTag}`);
    } else {
      addLog(`${attacker.name} fires on ${defenderSnapshot.name}${rangeTag} — rolled ${result.total} vs TN${tn}+${shieldTag}${coverTag} — MISS.`);
    }

    setUnits((prev) => {
      const next = prev.map((u) => {
        if (u.id !== defenderId) return u;
        const updated = { ...u, hp: Math.max(0, u.hp - hullDmg) };
        if (isFlatArmor) updated.armor = Math.max(0, u.armor - armorAbsorbed);
        else if (isFacingArmor) updated.armor = { ...u.armor, [hitFacing]: newFacingColumns };
        return updated;
      });
      if (result.dmg > 0) {
        const target = next.find((u) => u.id === defenderId);
        if (target.hp === 0) addLog(`${target.name} is destroyed!`);
      }
      unitsRef.current = next;
      return next;
    });
    await delay(300);
    setBusy(false);
  }

  function handleCellClick({ unitId, key }) {
    if (busy || phase === "gameover") return;
    const occupant = unitId ? units.find((u) => u.id === unitId) : null;

    // Clicking an enemy unit always shows limited recon data on it in the
    // sidebar, regardless of phase — this is separate from selectedId
    // (which is reserved for the player's own units) and doesn't stop the
    // click from also triggering an attack below if it's a valid one.
    if (occupant && occupant.side === "enemy") setScoutedId(occupant.id);

    if (phase === "playerMove") {
      if (occupant && occupant.side === "player" && !occupant.moved) { setSelectedId(occupant.id); return; }
      if (selected && !selected.moved && moveOptions.has(key) && !occupant) {
        const fields = activeScale.applyMove(selected, key);
        const isThrustUnit = typeof selected.thrust === "number";
        // Safe-speed hazard check happens BEFORE the move-finalizing
        // setUnits below, using the still-current `selected` (its .move is
        // this turn's speed, unaffected by the position/facing update
        // about to happen) — see GROUND_SCALE.evaluateMoveHazard.
        const hazard = activeScale.evaluateMoveHazard && activeScale.evaluateMoveHazard(selected, key);
        // Movement finalizes here — for thrust units, whatever budget was
        // just used (baseMove + whatever acceleration was dialed in)
        // freezes as postMoveBaseMove, the stable reference decelerateSelected
        // recomputes baseMove from afterward — see the architecture
        // comment on Grav Tank movement. Rotating in place deliberately
        // does NOT do this (see rotateSelected) — only an actual move
        // banks a new baseline. Thrust units stay selected so the
        // DECEL controls remain available now that the unit has moved.
        setUnits((prev) => prev.map((u) => (u.id === selected.id
          ? { ...u, ...fields, moved: true, ...(isThrustUnit ? { baseMove: u.move, postMoveBaseMove: u.move } : {}) }
          : u)));
        applyMoveHazard(selected.id, selected.name, hazard);
        if (!isThrustUnit) setSelectedId(null);
        return;
      }
      setSelectedId(null);
    } else if (phase === "playerFire") {
      if (occupant && occupant.side === "player" && !occupant.fired) { setSelectedId(occupant.id); return; }
      if (selected && !selected.fired && occupant && occupant.side === "enemy" && attackOptions.has(occupant.id)) {
        const atk = selected;
        setUnits((prev) => prev.map((u) => (u.id === atk.id ? { ...u, fired: true } : u)));
        setSelectedId(null);
        resolveAttack(atk, occupant.id).then(() => checkWin(unitsRef.current));
        return;
      }
      setSelectedId(null);
    }
  }

  // Turn the selected unit in place without relocating it — same as moving,
  // this uses up the unit's move action for the turn. Unrestricted for
  // every unit type, including Grav Tank — the start/end restriction
  // applies to Thrust application (see accelerateSelected/decelerateSelected below), not rotation.
  // Only meaningful for scales with a discrete hex facing (facingMode ===
  // "hex6" — see Ground).
  function rotateSelected(delta) {
    if (busy || phase !== "playerMove" || !selected || selected.moved) return;
    if (activeScale.facingMode !== "hex6" || typeof selected.facing !== "number") return;
    const id = selected.id;
    setUnits((prev) => prev.map((u) => (u.id === id ? { ...u, facing: ((u.facing + delta) % 6 + 6) % 6, moved: true } : u)));
    setSelectedId(null);
  }

  // Accelerate (delta=+1) or back off an accel choice (delta=-1) — ONLY
  // usable before the selected Grav Tank has moved this turn ("the
  // start"). Directly sets this turn's move budget: move is always
  // recomputed as baseMove + accelUsed, so repeated presses let the player
  // dial in an exact amount rather than an all-or-nothing boost.
  // accelUsed + decelUsed can never exceed `thrust`.
  function accelerateSelected(delta) {
    if (busy || phase !== "playerMove" || !selected || selected.moved) return;
    if (typeof selected.thrust !== "number") return;
    const newAccel = selected.accelUsed + delta;
    if (newAccel < 0 || newAccel + selected.decelUsed > selected.thrust) return;
    const id = selected.id;
    setUnits((prev) => prev.map((u) => (u.id === id ? { ...u, accelUsed: newAccel, move: u.baseMove + newAccel } : u)));
  }

  // Decelerate (delta=+1) or back off a decel choice (delta=-1) — ONLY
  // usable AFTER the selected Grav Tank has moved this turn ("the end").
  // Doesn't grant any more movement — it reshapes what baseMove becomes
  // next turn, recomputed fresh each press from the stable
  // postMoveBaseMove reference frozen when this turn's move finalized
  // (see handleCellClick), not accumulated by repeated subtraction — so
  // the player can walk a decel choice back up too, same as accelerate.
  function decelerateSelected(delta) {
    if (busy || phase !== "playerMove" || !selected || !selected.moved) return;
    if (typeof selected.thrust !== "number") return;
    const newDecel = selected.decelUsed + delta;
    if (newDecel < 0 || selected.accelUsed + newDecel > selected.thrust) return;
    if (selected.postMoveBaseMove - newDecel < 0) return;
    const id = selected.id;
    setUnits((prev) => prev.map((u) => (u.id === id ? { ...u, decelUsed: newDecel, baseMove: selected.postMoveBaseMove - newDecel } : u)));
  }

  // Movement Phase (both sides): player moves first (via handleCellClick),
  // then this hands off to the AI's movement pass. No firing happens here
  // for either side — that's the separate Weapon Phase below.
  async function endMovementPhase() {
    if (busy) return;
    setSelectedId(null);
    setPhase("enemyMove");
    addLog("-- ENEMY MOVEMENT PHASE --");
    await runEnemyMovement();
    setPhase("playerFire");
    addLog("-- WEAPON PHASE --");
  }

  // Weapon Phase (both sides): player fires first (via handleCellClick),
  // then this hands off to the AI's fire pass, then the turn fully ends —
  // both sides have now moved AND fired before anyone moves again.
  async function endFirePhase() {
    if (busy) return;
    setSelectedId(null);
    setPhase("enemyFire");
    addLog("-- ENEMY WEAPON PHASE --");
    await runEnemyFire();
    if (checkWin(unitsRef.current)) return;
    setUnits((prev) => prev.map((u) => (u.side === "player"
      ? { ...u, moved: false, fired: false, ...(typeof u.thrust === "number" ? { accelUsed: 0, decelUsed: 0, move: u.baseMove } : {}) }
      : u)));
    setTurn((t) => t + 1);
    setPhase("playerMove");
    addLog(`-- YOUR TURN ${turn + 1}: MOVEMENT PHASE --`);
  }

  /* Generic AI movement pass: works for any scale that implements
     computeMoveOptions, applyMove, distanceUnits, and distanceKeyToUnit.
     No hex-specific logic here, and no firing — this only moves enemy
     units toward their nearest target, mirroring the player's Movement
     Phase. Firing is a fully separate pass (runEnemyFire, below), so both
     sides' movement is locked in before anyone on either side shoots —
     the whole point of the "both sides move, then both sides fire"
     sequence this turn structure implements. */
  async function runEnemyMovement() {
    setBusy(true);
    const enemyIds = unitsRef.current.filter((u) => u.side === "enemy" && u.hp > 0).map((u) => u.id);
    for (const id of enemyIds) {
      let unit = unitsRef.current.find((u) => u.id === id);
      if (!unit || unit.hp <= 0) continue;

      // Thrust-capable enemy units get a fresh Thrust budget each of their
      // own turns too, same as the player-side reset in endFirePhase.
      if (typeof unit.thrust === "number") {
        setUnits((prev) => {
          const next = prev.map((u) => (u.id === id ? { ...u, accelUsed: 0, decelUsed: 0, move: u.baseMove } : u));
          unitsRef.current = next;
          return next;
        });
        unit = unitsRef.current.find((u) => u.id === id);
      }

      const targets = unitsRef.current.filter((u) => u.side === "player" && u.hp > 0);
      if (!targets.length) break;

      let nearest = targets[0];
      let bestDist = Infinity;
      targets.forEach((t) => {
        const d = activeScale.distanceUnits(unit, t);
        if (d < bestDist) { bestDist = d; nearest = t; }
      });

      // Grav tanks: accelerate before moving if base move alone won't
      // close the distance — the AI equivalent of a player choosing to
      // accelerate at "the start," spending only as much of the budget as
      // actually needed (not necessarily the full thrust bonus). The AI
      // never decelerates, as a simplification.
      if (typeof unit.thrust === "number" && unit.accelUsed === 0 && bestDist > unit.move) {
        const neededExtra = Math.min(unit.thrust, bestDist - unit.move);
        const boostedMove = unit.move + neededExtra;
        setUnits((prev) => {
          const next = prev.map((u) => (u.id === id ? { ...u, accelUsed: neededExtra, move: boostedMove } : u));
          unitsRef.current = next;
          return next;
        });
        unit = unitsRef.current.find((u) => u.id === id);
        addLog(`${unit.name} accelerates, boosting movement to ${boostedMove}.`);
      }

      if (bestDist > unit.range) {
        const options = activeScale.computeMoveOptions(unit, unitsRef.current);
        let bestKey = null, bestScore = bestDist;
        options.forEach((key) => {
          const d = activeScale.distanceKeyToUnit(key, nearest);
          if (d < bestScore) { bestScore = d; bestKey = key; }
        });
        if (bestKey) {
          const fields = activeScale.applyMove(unit, bestKey);
          const hazard = activeScale.evaluateMoveHazard && activeScale.evaluateMoveHazard(unit, bestKey);
          addLog(`${unit.name} advances toward ${nearest.name}.`);
          setUnits((prev) => {
            // Same momentum carry-forward as the player's move-completion
            // branch in handleCellClick — whatever move budget this AI
            // unit just used becomes its new baseMove next turn.
            const next = prev.map((u) => (u.id === id
              ? { ...u, ...fields, ...(typeof u.thrust === "number" ? { baseMove: u.move, postMoveBaseMove: u.move } : {}) }
              : u));
            unitsRef.current = next;
            return next;
          });
          applyMoveHazard(id, unit.name, hazard);
          await delay(450);
        } else {
          addLog(`${unit.name} holds position — no clear path.`);
          await delay(250);
        }
      }
    }
    setBusy(false);
  }

  /* Generic AI fire pass: runs after BOTH sides have finished moving for
     the turn, so every enemy unit fires from its final post-movement
     position at whatever's currently in range — no movement happens here.
     Targets are picked via computeAttackOptions (range + line-of-sight
     together, same as the player's UI and the same reasoning as before:
     one source of truth rather than a separate distance-only check that
     could drift), nearest attackable target first. */
  async function runEnemyFire() {
    setBusy(true);
    const enemyIds = unitsRef.current.filter((u) => u.side === "enemy" && u.hp > 0).map((u) => u.id);
    for (const id of enemyIds) {
      const unit = unitsRef.current.find((u) => u.id === id);
      if (!unit || unit.hp <= 0) continue;
      const targets = unitsRef.current.filter((u) => u.side === "player" && u.hp > 0);
      if (!targets.length) break;

      const attackable = activeScale.computeAttackOptions(unit, unitsRef.current);
      if (!attackable.size) continue;
      let best = null, bestDist = Infinity;
      targets.forEach((t) => {
        if (!attackable.has(t.id)) return;
        const d = activeScale.distanceUnits(unit, t);
        if (d < bestDist) { bestDist = d; best = t; }
      });
      if (best) {
        await resolveAttack(unit, best.id);
        if (checkWin(unitsRef.current)) { setBusy(false); return; }
      }
    }
    setBusy(false);
  }

  const phaseLabel = { playerMove: "MOVEMENT PHASE", enemyMove: "ENEMY MOVEMENT PHASE", playerFire: "WEAPON PHASE", enemyFire: "ENEMY WEAPON PHASE", gameover: "BATTLE OVER" }[phase];

  return (
    <div style={styles.app}>
      <div style={styles.banner}>
        <div style={styles.bannerTitle}>WAR ENGINE</div>
        <div style={styles.bannerSub}>UNITED SOVEREIGN PLANETS vs TERRAIN SOCIALIST REPUBLIC</div>
      </div>

      <div style={styles.scaleTabs}>
        {SCALES.map((s) => (
          <button
            key={s.id}
            onClick={() => switchScale(s.id)}
            style={{ ...styles.scaleTab, ...(s.id === scaleId ? styles.scaleTabActive : {}) }}
          >
            {s.label}{!s.ready && <span style={styles.comingSoon}>SOON</span>}
          </button>
        ))}
      </div>

      {!activeScale.ready ? (
        <ScalePreview scale={activeScale} onBack={() => switchScale("ground")} />
      ) : (
        <>
          <div style={styles.turnBar}>
            <span style={styles.turnBadge}>TURN {turn}</span>
            <span style={{ ...styles.turnBadge, background: (phase === "enemyMove" || phase === "enemyFire") ? COLORS.bloodPrimary : COLORS.steelPrimary }}>{phaseLabel}</span>
            <div style={{ flex: 1 }} />
            {phase === "playerMove" && <button style={styles.btn} onClick={endMovementPhase} disabled={busy}>END MOVEMENT ▸</button>}
            {phase === "playerFire" && <button style={styles.btn} onClick={endFirePhase} disabled={busy}>END WEAPON PHASE ▸</button>}
          </div>

          <div style={styles.mainRow}>
            <div style={styles.sidebar}>
              <div style={styles.cardHeader}>UNIT DATASHEET</div>
              {selected ? <StatCard unit={selected} scale={activeScale} /> : <div style={styles.emptyCard}>SELECT A UNIT ON THE FIELD</div>}
              {phase === "playerMove" && selected && !selected.moved && activeScale.facingMode === "hex6" && (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <button style={styles.btnSmall} onClick={() => rotateSelected(-1)} disabled={busy}>◂ ROTATE</button>
                  <button style={styles.btnSmall} onClick={() => rotateSelected(1)} disabled={busy}>ROTATE ▸</button>
                </div>
              )}
              {phase === "playerMove" && selected && typeof selected.thrust === "number" && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 9.5, color: COLORS.gunmetal, marginBottom: 4, fontFamily: "'Share Tech Mono', monospace" }}>
                    THRUST BUDGET: {selected.thrust - selected.accelUsed - selected.decelUsed}/{selected.thrust} remaining
                  </div>
                  {!selected.moved ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button style={styles.btnSmall} onClick={() => accelerateSelected(-1)} disabled={busy || selected.accelUsed <= 0}>− ACCEL</button>
                      <button style={styles.btnSmall} onClick={() => accelerateSelected(1)} disabled={busy || selected.accelUsed + selected.decelUsed >= selected.thrust}>+ ACCEL</button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button style={styles.btnSmall} onClick={() => decelerateSelected(-1)} disabled={busy || selected.decelUsed <= 0}>− DECEL</button>
                      <button style={styles.btnSmall} onClick={() => decelerateSelected(1)} disabled={busy || selected.accelUsed + selected.decelUsed >= selected.thrust || selected.postMoveBaseMove - selected.decelUsed <= 0}>+ DECEL</button>
                    </div>
                  )}
                </div>
              )}
              <div style={{ marginTop: 12 }}>
                <div style={styles.cardHeader}>ENEMY CONTACT</div>
                {scouted ? <ScoutCard unit={scouted} /> : <div style={styles.emptyCard}>CLICK AN ENEMY UNIT TO SCOUT IT</div>}
              </div>
              <div style={styles.diceTray}>
                <div style={styles.cardHeader}>LAST ROLL</div>
                {dice ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 4px" }}>
                    <Die value={dice.d1} /> <Die value={dice.d2} />
                    <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13 }}>
                      {dice.rolling ? "rolling…" : `= ${dice.d1 + dice.d2} vs TN${dice.target}+ ${dice.hit ? "HIT" : "MISS"}`}
                    </div>
                  </div>
                ) : (
                  <div style={{ padding: "6px 4px", fontFamily: "'Share Tech Mono', monospace", fontSize: 12, color: COLORS.gunmetal }}>no rolls yet</div>
                )}
              </div>
            </div>

            <div style={styles.boardWrap}>
              <activeScale.MapView units={units} selectedId={selectedId} moveOptions={moveOptions} attackOptions={attackOptions} phase={phase} busy={busy} onCellClick={handleCellClick} />
              {phase === "gameover" && (
                <div style={styles.overlay}>
                  <div style={{ ...styles.stamp, color: winner === "player" ? COLORS.steelPrimary : COLORS.rust, borderColor: winner === "player" ? COLORS.steelPrimary : COLORS.rust }}>
                    {winner === "player" ? "VICTORY" : "DEFEAT"}
                  </div>
                  <button style={{ ...styles.btn, fontSize: 15, padding: "10px 22px" }} onClick={() => switchScale(scaleId)}>NEW BATTLE</button>
                </div>
              )}
            </div>

            <div style={styles.logPanel}>
              <div style={styles.cardHeader}>BATTLE LOG</div>
              <div style={styles.logBody}>
                {log.map((l, i) => <div key={i} style={styles.logLine}>&gt; {l}</div>)}
                <div ref={logEndRef} />
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={styles.cardHeader}>MAP KEY</div>
                <MapKey />
              </div>
            </div>
          </div>

          <div style={styles.footer}>
            MOVE units in the green highlight during Movement Phase (facing auto-updates to your direction of travel, or ROTATE in place), then FIRE on dashed-outlined targets during Weapon Phase. To-hit is range-based: TN 3+ at range 1 (all but certain), then +1 TN per widening band — TN4 at range 2-3, TN5 at 4-6, TN6 at 7-10, up to TN8 by range 16-21. Elevated terrain (and woods, which count as +1 height for sighting only) can block line of sight. Climbing costs +1 movement per level gained, descending is discounted at half that rate; Light Woods cost +1 to enter and Heavy Woods +2, on top of any elevation cost. Standing in woods also raises the attacker's TN to hit you — +1 Light, +2 Heavy. Infantry deal damage equal to their own current Hull — a squad hits harder at full strength and weaker as it takes losses — and spray vehicle armor as a cone centered on a random column instead of draining it evenly.
            <button style={{ ...styles.btnSmall, marginLeft: 12 }} onClick={() => switchScale(scaleId)} disabled={busy && phase !== "gameover"}>Restart Battle</button>
          </div>
        </>
      )}
    </div>
  );
}

function StatCard({ unit, scale }) {
  const pct = unit.hp / unit.maxHp;
  return (
    <div style={styles.statCard}>
      <div style={{ fontFamily: "'Black Ops One', sans-serif", fontSize: 15, color: unit.side === "player" ? COLORS.steelPrimary : COLORS.bloodPrimary, letterSpacing: 1 }}>
        {unit.name}
      </div>
      <div style={styles.statRow}><span>TYPE</span><span>{(unit.className || unit.type)?.toUpperCase()}</span></div>
      {scale.facingMode === "hex6" && typeof unit.facing === "number" && (
        <div style={styles.statRow}><span>FACING</span><span>{G_FACING_ARROWS[unit.facing]} ({unit.facing + 1}/6)</span></div>
      )}
      {scale.statFields.filter((f) => unit[f.key] !== undefined && !(f.key === "move" && typeof unit.thrust === "number")).map((f) => (
        <div key={f.key} style={styles.statRow}>
          <span>{f.label}</span>
          <span style={f.key === "powerLine" && unit.overdrawn ? { color: COLORS.rust, fontWeight: "bold" } : undefined}>
            {unit[f.key]}{f.suffix || ""}{f.key === "powerLine" && unit.overdrawn ? " ⚠" : ""}
          </span>
        </div>
      ))}
      {unit.type === "infantry" && (
        <div style={styles.statRow}><span>ATTACK</span><span>= Hull ({unit.hp})</span></div>
      )}
      {typeof unit.thrust === "number" && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 9.5, letterSpacing: 1, fontWeight: "bold", color: COLORS.gunmetal, marginBottom: 2 }}>MOVE / THRUST</div>
          <div style={{ ...styles.statRow, fontSize: 10.5 }}><span>BASE MOVE</span><span>{unit.baseMove} HEX</span></div>
          <div style={{ ...styles.statRow, fontSize: 10.5 }}><span>THRUST BONUS</span><span>+{unit.thrust} HEX</span></div>
          <div style={{ ...styles.statRow, fontSize: 10.5 }}><span>ACCEL USED</span><span>+{unit.accelUsed} HEX</span></div>
          <div style={{ ...styles.statRow, fontSize: 10.5 }}><span>DECEL USED</span><span>−{unit.decelUsed} HEX</span></div>
          <div style={{ ...styles.statRow, fontSize: 10.5 }}><span>TURN RADIUS</span><span>{gTurnRadius(unit.move)} HEX (straight, between turns)</span></div>
        </div>
      )}
      {Array.isArray(unit.weapons) && unit.weapons.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 9.5, letterSpacing: 1, fontWeight: "bold", color: COLORS.gunmetal, marginBottom: 2 }}>WEAPONS LOADOUT</div>
          {unit.weapons.map((w, i) => (
            <div key={i} style={{ ...styles.statRow, fontSize: 10.5 }}>
              <span>{w.name}</span><span>{w.dmg} dmg / {w.power} pwr / {w.arc || "\u2014"} / {w.damageType || "\u2014"}</span>
            </div>
          ))}
        </div>
      )}
      {unit.shield && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 9.5, letterSpacing: 1, fontWeight: "bold", color: COLORS.gunmetal, marginBottom: 2 }}>SHIELD</div>
          <div style={{ ...styles.statRow, fontSize: 10.5 }}>
            <span>{unit.shield.name}</span>
            <span>+{unit.shield.tnModifier} TN vs {unit.shield.blocks.join("/")}</span>
          </div>
        </div>
      )}
      {unit.armor && typeof unit.armor === "object" && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 9.5, letterSpacing: 1, fontWeight: "bold", color: COLORS.gunmetal, marginBottom: 3 }}>{scale.armorLabel || "ARMOR"} BY FACING</div>
          {FACINGS.map((f) => {
            const maxCols = unit.armorMax[f] || [];
            const curCols = unit.armor[f] || [];
            const max = sumColumns(maxCols);
            const cur = sumColumns(curCols);
            return (
              <div key={f} style={{ marginBottom: 4 }}>
                <div style={{ ...styles.statRow, marginBottom: 1, fontSize: 10.5 }}><span>{f.toUpperCase()}</span><span>{cur}/{max}{max === 0 ? " (unarmored)" : ""}</span></div>
                <div style={{ display: "flex", gap: 1 }}>
                  {curCols.map((v, i) => {
                    const colMax = maxCols[i] || 1;
                    const frac = colMax > 0 ? v / colMax : 0;
                    return (
                      <div key={i} title={`col ${i + 1}: ${v}/${colMax}`} style={{ flex: 1, height: 10, background: COLORS.ink, borderRadius: 1, overflow: "hidden" }}>
                        <div style={{ width: "100%", height: `${frac * 100}%`, marginTop: `${(1 - frac) * 10}px`, background: frac > 0 ? COLORS.steelHi : "transparent" }} />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {typeof unit.armorMax === "number" && (
        <div style={{ marginTop: 6 }}>
          <div style={{ ...styles.statRow, marginBottom: 2 }}><span>{scale.armorLabel || "ARMOR"}</span><span>{unit.armor}/{unit.armorMax} ({unit.armorMax / 10} rows)</span></div>
          <div style={{ background: COLORS.ink, height: 8, borderRadius: 1 }}>
            <div style={{ width: `${(unit.armor / unit.armorMax) * 100}%`, height: "100%", background: COLORS.steelHi }} />
          </div>
        </div>
      )}
      <div style={{ marginTop: 6 }}>
        <div style={{ ...styles.statRow, marginBottom: 2 }}><span>{scale.hullLabel}</span><span>{unit.hp}/{unit.maxHp}</span></div>
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

/* Deliberately limited — this is what a player can tell about an enemy unit
   from a distance: its class and how banged-up its armor looks per facing,
   nothing else. No weapons, no power budget, no shield, no skill/damage
   stats, and — for facing armor — no column-level breakdown, just the
   aggregate current/max per facing (compare to StatCard's full per-column
   strip for the player's OWN units). Infantry-type armor (a flat number,
   no facings) is shown the same way it always was, just without any of the
   unit's other stats. */
function ScoutCard({ unit }) {
  const isFacingArmor = unit.armor && typeof unit.armor === "object";
  return (
    <div style={styles.statCard}>
      <div style={{ fontFamily: "'Black Ops One', sans-serif", fontSize: 14, color: COLORS.bloodPrimary, letterSpacing: 1 }}>
        {unit.name}
      </div>
      <div style={styles.statRow}><span>CLASS</span><span>{(unit.className || unit.type)?.toUpperCase()}</span></div>
      {isFacingArmor ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 9.5, letterSpacing: 1, fontWeight: "bold", color: COLORS.gunmetal, marginBottom: 3 }}>ARMOR (SCOUTED)</div>
          {FACINGS.map((f) => {
            const max = sumColumns(unit.armorMax[f]);
            const cur = sumColumns(unit.armor[f]);
            return (
              <div key={f} style={{ marginBottom: 3 }}>
                <div style={{ ...styles.statRow, marginBottom: 1, fontSize: 10.5 }}><span>{f.toUpperCase()}</span><span>{cur}/{max}</span></div>
                <div style={{ background: COLORS.ink, height: 6, borderRadius: 1 }}>
                  <div style={{ width: `${max > 0 ? (cur / max) * 100 : 0}%`, height: "100%", background: COLORS.bloodHi }} />
                </div>
              </div>
            );
          })}
        </div>
      ) : typeof unit.armorMax === "number" && (
        <div style={{ marginTop: 6 }}>
          <div style={{ ...styles.statRow, marginBottom: 2 }}><span>ARMOR (SCOUTED)</span><span>{unit.armor}/{unit.armorMax}</span></div>
          <div style={{ background: COLORS.ink, height: 8, borderRadius: 1 }}>
            <div style={{ width: `${(unit.armor / unit.armorMax) * 100}%`, height: "100%", background: COLORS.bloodHi }} />
          </div>
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 9.5, color: COLORS.gunmetal, fontFamily: "'Share Tech Mono', monospace", fontStyle: "italic" }}>
        weapons, power, and crew skill unknown
      </div>
    </div>
  );
}

/* Legend for every visual symbol currently in use on the battlefield —
   terrain (elevation gradient, contour lines, rivers/lakes, woods),
   gameplay highlights (move range, attack targets, selection), and unit
   markers (faction color, facing arrow). Grows as map features do;
   nothing here reads game state, it's pure reference. */
function MapKey() {
  const swatch = (bg, extra = {}) => <div style={{ width: 14, height: 14, background: bg, border: `1px solid ${COLORS.ink}`, flexShrink: 0, ...extra }} />;
  const row = (icon, label) => (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
      {icon}
      <span style={{ fontSize: 10, color: "#3a382e", lineHeight: 1.2 }}>{label}</span>
    </div>
  );
  return (
    <div>
      {row(
        <div style={{ display: "flex", width: 14, height: 14, border: `1px solid ${COLORS.ink}`, flexShrink: 0 }}>
          {[0, 2, 4, 6].map((h) => <div key={h} style={{ flex: 1, background: gHeightColor(h) }} />)}
        </div>,
        "Elevation 0 (dark) \u2192 6 (light)"
      )}
      {row(
        <svg width="14" height="14" style={{ flexShrink: 0 }}><line x1="1" y1="7" x2="13" y2="7" stroke={COLORS.contour} strokeWidth="2" /></svg>,
        "Contour line — clustered = steep"
      )}
      {row(
        <svg width="14" height="14" style={{ flexShrink: 0 }}><line x1="1" y1="7" x2="13" y2="7" stroke="#2f5a8a" strokeWidth="4" strokeLinecap="round" /></svg>,
        "River (flows downhill)"
      )}
      {row(<div style={{ width: 14, height: 14, background: "#3a6ea5", opacity: 0.55, border: `1px solid ${COLORS.ink}`, flexShrink: 0 }} />, "Lake / pooled water")}
      {row(
        <svg width="14" height="14" style={{ flexShrink: 0 }}><polygon points="7,3 3,11 11,11" fill="#5a7a4a" stroke={COLORS.ink} strokeWidth="0.6" /></svg>,
        "Light Woods — +1 move to enter"
      )}
      {row(
        <svg width="14" height="14" style={{ flexShrink: 0 }}><polygon points="7,2 2,12 12,12" fill="#3d5a30" stroke={COLORS.ink} strokeWidth="0.6" /></svg>,
        "Heavy Woods — +2 move to enter"
      )}
      {row(swatch("#a7c08f"), "Reachable this move")}
      {row(<div style={{ width: 14, height: 14, border: `2px dashed ${COLORS.rust}`, flexShrink: 0 }} />, "Valid attack target")}
      {row(swatch(COLORS.steelPrimary), "United Sovereign Planets unit")}
      {row(swatch(COLORS.bloodPrimary), "Terrain Socialist Republic unit")}
      {row(
        <svg width="14" height="14" style={{ flexShrink: 0 }}><polygon points="12,7 5,4 5,10" fill={COLORS.warn} stroke={COLORS.ink} strokeWidth="0.5" /></svg>,
        "Unit facing"
      )}
      {row(<div style={{ width: 14, height: 14, border: `2px solid ${COLORS.warn}`, borderRadius: "50%", flexShrink: 0 }} />, "Selected unit")}
      <div style={{ fontSize: 9.5, color: COLORS.gunmetal, marginTop: 4, fontStyle: "italic" }}>
        In-range targets behind a higher ridge (or a stand of woods, which counts as +1 height for sighting only) won't show a dashed outline. Climbing costs +1 move/level, descending refunds half that; woods add their own flat cost on top regardless of elevation, and give whoever's standing in them a defense bonus (+1 Light, +2 Heavy TN) too.
      </div>
    </div>
  );
}

function ScalePreview({ scale, onBack }) {
  return (
    <div style={styles.previewWrap}>
      <div style={styles.previewCard}>
        <div style={styles.previewBadge}>IN DEVELOPMENT</div>
        <div style={{ fontFamily: "'Black Ops One', sans-serif", fontSize: 20, letterSpacing: 1, marginTop: 8 }}>{scale.label}</div>
        <div style={{ fontSize: 13, marginTop: 6, color: COLORS.gunmetal }}>{scale.tagline}</div>

        <div style={{ marginTop: 16, fontSize: 11, letterSpacing: 2, fontWeight: "bold", color: COLORS.gunmetal }}>PLANNED DATASHEET FIELDS</div>
        <div style={styles.previewFields}>
          {scale.statFields.map((f) => <span key={f.key} style={styles.previewField}>{f.label}</span>)}
          <span style={styles.previewField}>{scale.hullLabel}</span>
        </div>

        <div style={{ marginTop: 16, fontSize: 11, letterSpacing: 2, fontWeight: "bold", color: COLORS.gunmetal }}>PLANNED MECHANICS</div>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5, lineHeight: 1.7 }}>
          {scale.plannedFeatures.map((f, i) => <li key={i}>{f}</li>)}
        </ul>

        <button style={{ ...styles.btn, marginTop: 18 }} onClick={onBack}>◂ BACK TO GROUND ASSAULT</button>
      </div>
    </div>
  );
}

const styles = {
  app: { fontFamily: "'Share Tech Mono', monospace", background: "#3a382e", padding: 14, color: COLORS.ink, minHeight: 600, boxSizing: "border-box" },
  banner: { background: COLORS.ink, padding: "10px 16px", textAlign: "center", borderTop: `4px solid ${COLORS.rust}`, borderBottom: `4px solid ${COLORS.rust}` },
  bannerTitle: { fontFamily: "'Black Ops One', sans-serif", fontSize: 26, color: "#e8dfc4", letterSpacing: 4 },
  bannerSub: { fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: COLORS.warn, letterSpacing: 3, marginTop: 2 },
  scaleTabs: { display: "flex", gap: 2, background: COLORS.gunmetal, padding: "0 4px" },
  scaleTab: { flex: 1, padding: "8px 6px", background: "#5a6058", color: "#d8d2b8", border: "none", fontFamily: "'Share Tech Mono', monospace", fontSize: 11.5, letterSpacing: 1.5, fontWeight: "bold", cursor: "pointer", position: "relative" },
  scaleTabActive: { background: COLORS.paper, color: COLORS.ink },
  comingSoon: { fontSize: 8, background: COLORS.warn, color: COLORS.ink, padding: "1px 4px", marginLeft: 5, borderRadius: 2, letterSpacing: 0.5 },
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
  logBody: { flex: 1, minHeight: 300, maxHeight: 460, overflowY: "auto", background: "#efe8d4", border: `2px solid ${COLORS.ink}`, padding: 8, fontSize: 11.5, lineHeight: 1.5 },
  logLine: { marginBottom: 3, color: "#2b2a24" },
  btn: { background: COLORS.rust, color: "#efe8d4", border: `2px solid ${COLORS.ink}`, padding: "6px 14px", fontFamily: "'Share Tech Mono', monospace", fontSize: 12, fontWeight: "bold", letterSpacing: 1, cursor: "pointer" },
  btnSmall: { background: COLORS.gunmetal, color: "#efe8d4", border: `2px solid ${COLORS.ink}`, padding: "3px 10px", fontFamily: "'Share Tech Mono', monospace", fontSize: 11, cursor: "pointer" },
  footer: { background: COLORS.ink, color: "#a99f80", fontSize: 11, padding: "8px 14px", display: "flex", alignItems: "center", flexWrap: "wrap" },
  overlay: { position: "absolute", inset: 0, background: "rgba(20,18,14,0.55)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 },
  stamp: { fontFamily: "'Black Ops One', sans-serif", fontSize: 44, letterSpacing: 4, border: "6px solid", padding: "10px 30px", transform: "rotate(-6deg)", background: "rgba(239,232,212,0.9)" },
  previewWrap: { background: COLORS.paper, padding: 30, display: "flex", justifyContent: "center" },
  previewCard: { background: "#eee7cf", border: `3px solid ${COLORS.ink}`, padding: 24, maxWidth: 460, width: "100%" },
  previewBadge: { display: "inline-block", background: COLORS.warn, color: COLORS.ink, fontSize: 10, letterSpacing: 2, fontWeight: "bold", padding: "3px 8px" },
  previewFields: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 },
  previewField: { background: COLORS.gunmetal, color: "#efe8d4", fontSize: 10.5, padding: "3px 8px", letterSpacing: 0.5 },
};

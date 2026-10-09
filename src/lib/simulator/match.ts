// src/lib/simulator/match.ts
// Simulates one full match, event by event, from a seed.
// Same seed + same league = identical match, every time.
//
// Coordinates: every event is in the ACTING team's frame (they always attack
// left to right, x 0 = own goal line, x 100 = opponent goal line, y 0-100 across).
// So a defender's tackle at x=30 happened 30% up the pitch from his own goal.

import type { EventOutcome, Id, LineupEntry, Match, MatchEvent, Player, Position, Team } from "../datasource/types";
import type { League } from "./league";
import { between, rng } from "./rng";

export interface FatigueSample {
  matchId: Id;
  playerId: Id;
  minute: number; // minutes played so far
  energy: number; // 1 = fresh, 0 = exhausted
}

export interface SimulateOptions {
  matchId: Id;
  homeTeamId: Id;
  awayTeamId: Id;
  seed: number;
  round?: number;
  season?: string;
}

export interface SimulatedMatch {
  match: Match;
  lineup: LineupEntry[];
  events: MatchEvent[];
  fatigue: FatigueSample[];
}

interface StyleParams {
  acc: number;       // pass accuracy modifier
  fwd: number;       // how forward passes travel
  shoot: number;     // shot appetite
  press: number;     // how often they pressure the ball carrier
  pressHigh: number; // extra pressing when the opponent builds from the back
  fatigue: number;   // energy drain multiplier
  tempo: number;     // seconds per action multiplier
}

const STYLE: Record<Team["style"], StyleParams> = {
  possession: { acc: 0.035, fwd: 0.75, shoot: 1.15, press: 0.6, pressHigh: 0.8, fatigue: 0.95, tempo: 1.12 },
  high_press: { acc: 0.0, fwd: 1.05, shoot: 0.95, press: 1.5, pressHigh: 1.9, fatigue: 1.2, tempo: 0.92 },
  counter: { acc: -0.015, fwd: 1.0, shoot: 1.0, press: 0.8, pressHigh: 0.6, fatigue: 1.0, tempo: 0.85 },
  direct: { acc: -0.06, fwd: 1.35, shoot: 1.0, press: 0.9, pressHigh: 0.9, fatigue: 1.05, tempo: 0.9 },
};

const HOME_X: Record<Position, number> = { GK: 5, DF: 30, MF: 52, FW: 76 };
const ROLE_FATIGUE: Record<Position, number> = { GK: 0.2, DF: 0.95, MF: 1.1, FW: 1.0 };
const DRAIN = 0.009; // energy lost per minute, scaled by stamina and style

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;

function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-9);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function weightedPick<T>(r: () => number, items: T[], weight: (t: T) => number): T {
  const w = items.map((i) => Math.max(0, weight(i)));
  const total = w.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(r() * items.length)];
  let roll = r() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= w[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

// Expected goals from where the shot is taken (distance and goal-mouth angle).
function shotGeometry(x: number, y: number) {
  const dx = Math.max((100 - x) * 1.05, 0.5); // metres to the goal line
  const dy = (y - 50) * 0.68;                 // metres off centre
  const dist = Math.hypot(dx, dy);
  const angle = Math.abs(Math.atan2(dy + 3.66, dx) - Math.atan2(dy - 3.66, dx));
  return { dist, angle };
}
export function baseXg(x: number, y: number): number {
  const { dist, angle } = shotGeometry(x, y);
  return clamp(0.5 * Math.pow(angle, 1.15) * Math.exp(-dist / 30), 0.01, 0.9);
}

interface Side {
  team: Team;
  style: StyleParams;
  isHome: boolean;
  field: Player[];
  bench: Player[];
  energy: Map<Id, number>;
  yellow: Set<Id>;
  subsUsed: number;
  nextSubMin: number;
  score: number;
}

function pickLineup(r: () => number, squad: Player[]) {
  const byPos = (pos: Position) =>
    squad
      .filter((p) => p.position === pos)
      .map((p) => ({ p, s: p.quality + between(r, -0.08, 0.08) }))
      .sort((a, b) => b.s - a.s)
      .map((x) => x.p);
  const gk = byPos("GK");
  const df = byPos("DF");
  const mf = byPos("MF");
  const fw = byPos("FW");
  const starters = [gk[0], ...df.slice(0, 4), ...mf.slice(0, 3), ...fw.slice(0, 3)];
  const bench = [gk[1], ...df.slice(4, 6), ...mf.slice(3, 5), ...fw.slice(3, 5)];
  const used = new Set([...starters, ...bench].map((p) => p.id));
  const unused = squad.filter((p) => !used.has(p.id));
  return { starters, bench, unused };
}

export function simulateMatch(league: League, o: SimulateOptions): SimulatedMatch {
  const r = rng(o.seed);
  const homeTeam = league.teams.find((t) => t.id === o.homeTeamId);
  const awayTeam = league.teams.find((t) => t.id === o.awayTeamId);
  if (!homeTeam || !awayTeam) throw new Error("Unknown team id");
  const round = o.round ?? 1;
  const lineup: LineupEntry[] = [];

  const build = (team: Team, isHome: boolean): Side => {
    const squad = league.players.filter((p) => p.teamId === team.id);
    const lu = pickLineup(r, squad);
    const late = r() < 0.3; // some managers leave tired legs on the pitch
    const side: Side = {
      team,
      style: STYLE[team.style],
      isHome,
      field: [...lu.starters],
      bench: [...lu.bench],
      energy: new Map(),
      yellow: new Set(),
      subsUsed: 0,
      nextSubMin: late ? between(r, 72, 84) : between(r, 54, 68),
      score: 0,
    };
    [...lu.starters, ...lu.bench].forEach((p) => side.energy.set(p.id, 1));
    lu.starters.forEach((p) => lineup.push({ matchId: o.matchId, playerId: p.id, teamId: team.id, role: "starter" }));
    lu.bench.forEach((p) => lineup.push({ matchId: o.matchId, playerId: p.id, teamId: team.id, role: "bench" }));
    lu.unused.forEach((p) => lineup.push({ matchId: o.matchId, playerId: p.id, teamId: team.id, role: "unused" }));
    return side;
  };
  const home = build(homeTeam, true);
  const away = build(awayTeam, false);
  const sides = [home, away];

  // Momentum spells: stretches of ~10 minutes where one side is on top.
  const spells = Array.from({ length: 12 }, () => between(r, -0.1, 0.1));

  const events: MatchEvent[] = [];
  const fatigue: FatigueSample[] = [];
  let seq = 0;
  let period: 1 | 2 = 1;
  let t = 0;      // seconds into the current period
  let played = 0; // seconds played in total
  let nextSample = 0;
  let bank = 0;   // stoppage time earned this period, in seconds

  let atk: Side = home;
  let def: Side = away;
  let x = 50;
  let y = 50;
  let holder: Player = home.field[0];
  let fast = 0;
  let deadBall = false;

  const emit = (e: Omit<MatchEvent, "id" | "matchId" | "seq" | "period" | "minute" | "second">) => {
    seq++;
    events.push({
      ...e,
      x: round1(e.x),
      y: round1(e.y),
      endX: e.endX === undefined ? undefined : round1(e.endX),
      endY: e.endY === undefined ? undefined : round1(e.endY),
      id: `${o.matchId}-e${String(seq).padStart(4, "0")}`,
      matchId: o.matchId,
      seq,
      period,
      minute: (period === 2 ? 45 : 0) + Math.floor(t / 60),
      second: Math.floor(t % 60),
    });
  };

  const takeSample = () => {
    const minute = Math.round(played / 60);
    // A newer reading for the same minute replaces the older one, so (match, player, minute) stays unique.
    while (fatigue.length > 0 && fatigue[fatigue.length - 1].minute === minute) fatigue.pop();
    for (const s of sides) {
      for (const p of s.field) {
        fatigue.push({ matchId: o.matchId, playerId: p.id, minute, energy: round2(s.energy.get(p.id) ?? 0) });
      }
    }
  };

  const advance = (dt: number) => {
    for (const s of sides) {
      for (const p of s.field) {
        const e = s.energy.get(p.id) ?? 1;
        const drain = DRAIN * (1.3 - p.stamina) * ROLE_FATIGUE[p.position] * s.style.fatigue * (dt / 60);
        s.energy.set(p.id, Math.max(0.05, e - drain));
      }
    }
    t += dt;
    played += dt;
    while (played >= nextSample) {
      takeSample();
      nextSample += 300;
    }
  };

  const qEff = (s: Side, p: Player) =>
    p.quality * (0.7 + 0.3 * (s.energy.get(p.id) ?? 1)) * (s.isHome ? 1.02 : 1) * Math.sqrt(s.field.length / 11);

  const edge = (s: Side) => {
    const spell = spells[Math.min(11, Math.floor(played / 600))];
    return (s.isHome ? spell : -spell) + (s.isHome ? 0.015 : 0);
  };

  const avgEnergy = (s: Side) => s.field.reduce((a, p) => a + (s.energy.get(p.id) ?? 1), 0) / s.field.length;

  const near = (s: Side, px: number, exclude?: Id) =>
    weightedPick(
      r,
      s.field.filter((p) => p.id !== exclude),
      (p) => Math.exp(-Math.abs(HOME_X[p.position] - px) / 14) * (p.position === "GK" ? 0.2 : 1),
    );

  const gkOf = (s: Side) => s.field.find((p) => p.position === "GK") ?? near(s, 5);

  const gameState = () => {
    const minute = (period === 2 ? 45 : 0) + t / 60;
    if (minute < 70) return 0;
    const d = atk.score - def.score;
    return d < 0 ? 0.3 : d > 0 ? -0.2 : 0.05;
  };

  const kickoff = (side: Side, other: Side) => {
    atk = side;
    def = other;
    x = 50;
    y = 50;
    holder = near(side, 52);
    fast = 0;
    emit({ type: "kickoff", teamId: side.team.id, playerId: holder.id, x: 50, y: 50 });
    advance(between(r, 2, 4));
  };

  // The ball changes hands. (wx, wy) is where it was lost, in the OLD attacker's frame.
  const turnover = (wx: number, wy: number, winner?: Player) => {
    const next = def;
    def = atk;
    atk = next;
    x = clamp(100 - wx, 1, 99);
    y = clamp(100 - wy, 1, 99);
    holder = winner ?? near(atk, x);
    fast = atk.team.style === "counter" ? 4 : 0;
    emit({ type: "possession_change", teamId: atk.team.id, playerId: holder.id, x, y });
  };

  const trySubs = (s: Side) => {
    const minute = (period === 2 ? 45 : 0) + t / 60;
    if (s.subsUsed >= 5 || s.bench.length === 0 || minute < s.nextSubMin) return;
    const outfield = s.field.filter((p) => p.position !== "GK");
    if (outfield.length === 0) return;
    const off = outfield.reduce((a, b) => ((s.energy.get(a.id) ?? 1) <= (s.energy.get(b.id) ?? 1) ? a : b));
    const options = s.bench.filter((p) => p.position === off.position);
    const pool = options.length > 0 ? options : s.bench.filter((p) => p.position !== "GK");
    if (pool.length === 0) return;
    const on = pool.reduce((a, b) => (a.quality >= b.quality ? a : b));
    s.field = s.field.filter((p) => p.id !== off.id).concat(on);
    s.bench = s.bench.filter((p) => p.id !== on.id);
    s.energy.set(on.id, 1);
    s.subsUsed++;
    s.nextSubMin = minute + between(r, 1, 5);
    bank += 30;
    emit({ type: "substitution", teamId: s.team.id, playerId: off.id, otherPlayerId: on.id, x: 50, y: 0 });
    if (holder.id === off.id) holder = near(atk, x);
  };

  const pressureLevel = (): number => {
    const hi = x < 40 ? def.style.pressHigh : 1;
    const p = clamp(0.16 * def.style.press * hi * (0.7 + 0.3 * avgEnergy(def)), 0, 0.6);
    if (r() > p) return 0;
    const presser = near(def, 100 - x);
    const level = clamp(0.35 + 0.25 * def.style.press + gauss(r) * 0.1, 0.2, 1);
    emit({
      type: "pressure", teamId: def.team.id, playerId: presser.id, otherPlayerId: holder.id,
      x: 100 - x, y: 100 - y, pressureIntensity: round2(level),
    });
    return level;
  };

  const doShot = (pr: number, pen = false) => {
    const shooter = weightedPick(
      r,
      atk.field,
      (p) => ({ GK: 0, DF: pen ? 0.2 : 0.35, MF: 1.6, FW: 4 }[p.position] * (0.6 + qEff(atk, p))),
    );
    const raw = pen ? 0.76 : baseXg(x, y) * between(r, 0.7, 1.35) * (1 - 0.22 * pr);
    const xg = clamp(raw, 0.01, 0.8);
    const keeper = gkOf(def);
    const finishing = pen ? 1 : 0.6 + 0.8 * qEff(atk, shooter);
    const keeperFactor = 1.25 - 0.4 * qEff(def, keeper);
    const g = clamp(xg * finishing * keeperFactor, 0.005, 0.97);
    const u = r();
    let outcome: EventOutcome;
    if (u < g) outcome = "goal";
    else {
      const v = (u - g) / (1 - g);
      outcome = v < 0.31 ? "blocked" : v < 0.72 ? "off_target" : v < 0.75 ? "post" : "saved";
      if (pen && outcome === "blocked") outcome = "off_target";
    }
    const dist = shotGeometry(x, y).dist;
    const speed = clamp(62 + 38 * qEff(atk, shooter) + gauss(r) * 7 - dist * 0.35, 55, 125);
    emit({
      type: "shot", teamId: atk.team.id, playerId: shooter.id, x, y,
      outcome, xg: round3(xg), speedKmh: Math.round(speed),
    });
    advance(between(r, 1.5, 3.5));

    const corner = () => {
      x = 97;
      y = r() < 0.5 ? 4 : 96;
      holder = near(atk, 52);
      deadBall = true;
      advance(between(r, 12, 20));
    };
    const keeperHolds = () => turnover(95, 50, keeper);

    if (outcome === "goal") {
      atk.score++;
      bank += between(r, 30, 50);
      advance(between(r, 25, 40));
      deadBall = true;
      kickoff(def, atk);
    } else if (outcome === "saved") {
      if (r() < 0.35) corner();
      else keeperHolds();
    } else if (outcome === "blocked") {
      if (r() < 0.4) corner();
      else turnover(x, y);
    } else if (outcome === "post") {
      if (r() < 0.4) {
        x = 93;
        y = clamp(50 + gauss(r) * 10, 10, 90);
        holder = near(atk, 76);
      } else {
        keeperHolds();
        deadBall = true;
      }
    } else {
      keeperHolds(); // off target: goal kick
      deadBall = true;
      advance(between(r, 6, 12));
    }
  };

  const doFoul = () => {
    const fouler = near(def, 100 - x);
    emit({ type: "foul", teamId: def.team.id, playerId: fouler.id, otherPlayerId: holder.id, x: 100 - x, y: 100 - y });
    advance(between(r, 4, 9));
    bank += 12;
    if (fouler.position !== "GK") {
      let card: "yellow" | "red" | null = null;
      if (r() < 0.002) card = "red";
      else if (r() < 0.16) {
        if (!def.yellow.has(fouler.id)) card = "yellow";
        else if (r() < 0.5) card = "red"; // second yellow
      }
      if (card) {
        if (card === "yellow") def.yellow.add(fouler.id);
        emit({ type: "card", teamId: def.team.id, playerId: fouler.id, x: 100 - x, y: 100 - y, cardColor: card });
        bank += 20;
        if (card === "red") def.field = def.field.filter((p) => p.id !== fouler.id);
      }
    }
    if (x > 83 && Math.abs(y - 50) < 24 && r() < 0.14) {
      x = 89.5;
      y = 50;
      advance(between(r, 40, 70)); // penalty set-up
      bank += 40;
      doShot(0, true);
    } else {
      advance(between(r, 10, 25));
      deadBall = true;
    }
  };

  const doDribble = (pr: number) => {
    const defender = near(def, 100 - x);
    const win = clamp(0.5 + (qEff(atk, holder) - qEff(def, defender)) * 0.9 - pr * 0.1, 0.2, 0.8);
    const ok = r() < win;
    emit({
      type: "duel", teamId: atk.team.id, playerId: holder.id, otherPlayerId: defender.id,
      x, y, outcome: ok ? "success" : "fail",
    });
    advance(between(r, 1.5, 3.5));
    if (ok) {
      x = clamp(x + between(r, 5, 13), 1, 99);
      y = clamp(y + gauss(r) * 8, 3, 97);
    } else {
      emit({
        type: "tackle", teamId: def.team.id, playerId: defender.id, otherPlayerId: holder.id,
        x: 100 - x, y: 100 - y, outcome: "success",
      });
      turnover(x, y, defender);
    }
  };

  const doPass = (pr: number) => {
    const fastMode = fast > 0;
    if (fast > 0) fast--;
    const e = edge(atk);
    const fwd = atk.style.fwd * (fastMode ? 1.7 : 1) * (1 + gameState() * 0.8 + e);
    const targetX = clamp(x + 6 * fwd + gauss(r) * 12, 4, 98);
    const receiver = weightedPick(
      r,
      atk.field.filter((p) => p.id !== holder.id),
      (p) => Math.exp(-Math.abs(HOME_X[p.position] - targetX) / 16) * (p.position === "GK" ? 0.25 : 1) * (0.7 + qEff(atk, p)),
    );
    const endX = clamp(targetX + gauss(r) * 3, 2, 99);
    const endY = clamp(y + gauss(r) * 18, 3, 97);
    const distM = Math.hypot((endX - x) * 1.05, (endY - y) * 0.68);
    const diff = clamp(0.07 + distM / 75 + Math.max(0, endX - x) / 130 + pr * 0.28 + gauss(r) * 0.03, 0.02, 0.98);
    const pSucc = clamp(0.975 + atk.style.acc - diff * 0.45 + (qEff(atk, holder) - 0.6) * 0.3 + e * 0.35, 0.12, 0.985);
    const ok = r() < pSucc;
    const speed = clamp(22 + distM * 1.9 + gauss(r) * 4, 20, 110);
    emit({
      type: "pass", teamId: atk.team.id, playerId: holder.id, otherPlayerId: receiver.id,
      x, y, endX, endY, outcome: ok ? "success" : "fail",
      passDistance: round1(distM), passDifficulty: round2(diff), speedKmh: Math.round(speed),
    });
    advance(between(r, 2.4, 7.0) * atk.style.tempo);
    if (ok) {
      x = endX;
      y = endY;
      holder = receiver;
      return;
    }
    const cause = r();
    if (cause < 0.2) {
      const winner = near(def, 100 - endX);
      emit({ type: "interception", teamId: def.team.id, playerId: winner.id, x: 100 - endX, y: 100 - endY, outcome: "success" });
      turnover(endX, endY, winner);
    } else if (cause < 0.4) {
      turnover(endX, endY); // ball out of play
      deadBall = true;
      advance(between(r, 5, 12));
    } else if (cause < 0.85) {
      turnover(endX, endY); // loose ball, second ball lost
    } else {
      const winner = near(def, 100 - endX);
      emit({ type: "tackle", teamId: def.team.id, playerId: winner.id, otherPlayerId: receiver.id, x: 100 - endX, y: 100 - endY, outcome: "success" });
      turnover(endX, endY, winner);
    }
  };

  for (const p of [1, 2] as const) {
    period = p;
    t = 0;
    bank = 0;
    let end: number | null = null;
    if (p === 1) kickoff(home, away);
    else kickoff(away, home);

    for (;;) {
      if (t >= 2700 && end === null) {
        end = 2700 + clamp(Math.round((bank + between(r, 10, 50)) / 60) * 60, 60, 360);
      }
      if (end !== null && t >= end) break;

      if (deadBall) {
        trySubs(home);
        trySubs(away);
        deadBall = false;
      }

      const pr = pressureLevel();
      if (r() < 0.02) {
        doFoul();
        continue;
      }
      const gs = gameState();
      const e = edge(atk);
      const base = x > 62 ? 0.09 * Math.pow((x - 62) / 38, 1.6) : x > 52 ? 0.003 : 0.0008;
      const pShoot = base * atk.style.shoot * Math.max(0.2, 1 + gs + e * 1.2) * (fast > 0 ? 1.3 : 1);
      if (r() < pShoot) {
        doShot(pr);
        continue;
      }
      const pDribble = (holder.position === "FW" ? 0.07 : holder.position === "MF" ? 0.035 : 0.008) * (x > 40 ? 1 : 0.4);
      if (r() < pDribble) {
        doDribble(pr);
        continue;
      }
      doPass(pr);
    }
    emit({ type: p === 1 ? "half_time" : "full_time", teamId: home.team.id, x: 50, y: 50 });
  }
  takeSample();

  const match: Match = {
    id: o.matchId,
    season: o.season ?? "2026/27",
    round,
    homeTeamId: home.team.id,
    awayTeamId: away.team.id,
    kickoffAt: new Date(Date.UTC(2026, 7, 15 + (round - 1) * 7, 15, 0, 0)).toISOString(),
    venue: `${home.team.name.split(" ")[0]} Park`,
    status: "finished",
    homeScore: home.score,
    awayScore: away.score,
    seed: o.seed,
  };

  return { match, lineup, events, fatigue };
}
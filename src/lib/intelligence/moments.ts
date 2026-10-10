// src/lib/intelligence/moments.ts
// The key-moment detector: finds the moments that matter and says WHY, using only the events.
// Pure code, no AI. Every moment carries:
//   evidence  the ids of the events that prove it (the Verifier agent and "click to see evidence" use these)
//   facts     the exact numbers behind the explanation (the Verifier checks claims against these)

import type { Id, MatchEvent } from "../datasource/types";
import { formatClock } from "./clock";
import type { MatchContext } from "./context";
import { sum, threatBins, threatOf } from "./momentum";

export type MomentType =
  | "goal" | "penalty_miss" | "big_chance" | "red_card" | "manager_call"
  | "momentum_shift" | "press_spell" | "control_spell" | "key_pass";

export type FactValue = string | number | boolean;

export interface KeyMoment {
  id: string;
  matchId: Id;
  type: MomentType;
  seq: number;          // the event to jump to
  seqFrom: number;      // the stretch of the match this moment covers
  seqTo: number;
  minute: number;
  second: number;
  clock: string;        // "67'", "90+2'"
  teamId?: Id;
  playerId?: Id;
  score: number;        // 0-100 importance
  headline: string;
  reason: string;       // plain English, every number comes from `facts`
  evidence: Id[];
  facts: Record<string, FactValue>;
}

export interface DetectOptions {
  energyThreshold?: number;   // "tired" below this energy (0-1)
  minStayMinutes?: number;    // tired for at least this long before it counts as a manager's call
  bigChanceXg?: number;
  keyPassDifficulty?: number;
  minControlPasses?: number;
  shiftGap?: number;          // how far a team's share of threat must move to count as a momentum shift
  minPressures?: number;
  minHighTurnovers?: number;
  shiftWindow?: number;       // minutes compared on each side of a momentum shift
  shiftMinThreat?: number;    // each window needs at least this much attacking threat to count
  maxCallsPerTeam?: number;   // manager's-call alerts kept per team (the worst case)
}

export const DEFAULT_OPTIONS: Required<DetectOptions> = {
  energyThreshold: 0.5,
  minStayMinutes: 6,
  bigChanceXg: 0.3,
  keyPassDifficulty: 0.55,
  minControlPasses: 22,
  shiftGap: 0.4,
  minPressures: 14,
  minHighTurnovers: 3,
  shiftWindow: 8,
  shiftMinThreat: 5,
  maxCallsPerTeam: 1,
};

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const clamp = (v: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, v));

export const isPenalty = (e: MatchEvent): boolean => e.type === "shot" && e.x === 89.5 && e.y === 50;
export const shotDistanceM = (e: MatchEvent): number => Math.hypot((100 - e.x) * 1.05, (e.y - 50) * 0.68);

const difficultyWord = (d: number) => (d >= 0.6 ? "difficult" : d >= 0.35 ? "tricky" : "simple");
const article = (n: number) => (/^(8|11|18)/.test(String(n)) ? "an" : "a");
const chanceWord = (xg: number) => {
  if (xg < 0.25) return `about a 1-in-${Math.max(2, Math.round(1 / xg))} chance`;
  const p = Math.round(xg * 100);
  return `${article(p)} ${p}% chance`;
};

export function detectMoments(ctx: MatchContext, options: DetectOptions = {}): KeyMoment[] {
  const o = { ...DEFAULT_OPTIONS, ...options };
  const ev = ctx.events;
  const bySeq = new Map<number, MatchEvent>(ev.map((e) => [e.seq, e]));
  const indexOfSeq = new Map<number, number>(ev.map((e, i) => [e.seq, i]));
  const homeId = ctx.match.homeTeamId;
  const awayId = ctx.match.awayTeamId;
  const other = (teamId: Id) => (teamId === homeId ? awayId : homeId);
  const pname = (id?: Id) => (id ? ctx.players.get(id)?.name : undefined) ?? "a player";
  const tname = (id?: Id) => (id ? ctx.teams.get(id)?.name : undefined) ?? "the team";
  const gkName = (teamId: Id) => {
    const l = ctx.lineup.find((x) => x.teamId === teamId && x.role === "starter" && ctx.players.get(x.playerId)?.position === "GK");
    return pname(l?.playerId);
  };

  const moments: KeyMoment[] = [];
  const add = (m: Omit<KeyMoment, "id" | "matchId" | "minute" | "second" | "clock" | "score"> & { score: number }) => {
    const anchor = bySeq.get(m.seq)!;
    moments.push({
      ...m,
      id: `${ctx.match.id}-mo-${m.type}-${m.seq}`,
      matchId: ctx.match.id,
      minute: anchor.minute,
      second: anchor.second,
      clock: formatClock(anchor),
      score: Math.round(clamp(m.score)),
    });
  };

  // ---------- final result (only known once the match is over) ----------
  const finalGoals: Record<Id, number> = { [homeId]: 0, [awayId]: 0 };
  for (const e of ev) if (e.type === "shot" && e.outcome === "goal") finalGoals[e.teamId]++;
  const winner = ctx.complete ? (finalGoals[homeId] > finalGoals[awayId] ? homeId : finalGoals[awayId] > finalGoals[homeId] ? awayId : null) : null;

  // ---------- goals, missed penalties, big chances, red cards ----------
  const running: Record<Id, number> = { [homeId]: 0, [awayId]: 0 };
  const yellowed = new Set<Id>();
  const reds: Record<Id, number> = { [homeId]: 0, [awayId]: 0 };
  const momentShots = new Set<number>(); // shots that already have their own moment

  const precedingFoul = (i: number, foulingTeam: Id) => {
    for (let j = i - 1; j >= Math.max(0, i - 8); j--) if (ev[j].type === "foul" && ev[j].teamId === foulingTeam) return ev[j];
    return undefined;
  };

  ev.forEach((e, i) => {
    if (e.type === "card" && e.playerId) {
      if (e.cardColor === "yellow") yellowed.add(e.playerId);
      if (e.cardColor === "red") {
        reds[e.teamId]++;
        const secondYellow = yellowed.has(e.playerId);
        const foul = precedingFoul(i, e.teamId);
        const left = 11 - reds[e.teamId];
        const remaining = Math.max(0, 90 - e.minute);
        add({
          type: "red_card", seq: e.seq, seqFrom: foul?.seq ?? e.seq, seqTo: e.seq,
          teamId: e.teamId, playerId: e.playerId,
          score: 58 + Math.min(22, remaining / 3),
          headline: `Red card: ${pname(e.playerId)} (${tname(e.teamId)})`,
          reason: `${pname(e.playerId)} is sent off in the ${formatClock(e)}${secondYellow ? " for a second yellow card" : ""}, leaving ${tname(e.teamId)} with ${left} players for the remaining ${remaining} or so minutes.`,
          evidence: [foul?.id, e.id].filter((x): x is string => !!x),
          facts: { player: pname(e.playerId), team: tname(e.teamId), secondYellow, playersLeft: left, minutesRemaining: remaining },
        });
      }
    }

    if (e.type !== "shot") return;
    const shooter = pname(e.playerId);
    const team = tname(e.teamId);
    const xg = e.xg ?? 0;
    const pen = isPenalty(e);
    const dist = r1(shotDistanceM(e));

    if (e.outcome === "goal") {
      const us = running[e.teamId];
      const them = running[other(e.teamId)];
      running[e.teamId]++;
      const nowHome = running[homeId];
      const nowAway = running[awayId];

      let label: string;
      let bonus = 0;
      if (us === 0 && them === 0) { label = "opens the scoring"; bonus = 5; }
      else if (us < them && us + 1 === them) { label = "equalises"; bonus = 12; }
      else if (us < them) { label = "pulls one back"; bonus = 6; }
      else if (us === them) { label = "puts them ahead"; bonus = 12; }
      else { label = "extends the lead"; bonus = 3; }

      // who set it up: a successful pass to the shooter in the few events before the shot
      let assist: MatchEvent | undefined;
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const p = ev[j];
        if (p.type === "pass" && p.outcome === "success" && p.teamId === e.teamId && p.otherPlayerId === e.playerId) { assist = p; break; }
      }
      const foul = pen ? precedingFoul(i, other(e.teamId)) : undefined;

      const isWinner = winner === e.teamId && running[e.teamId] === finalGoals[other(e.teamId)] + 1;
      const late = e.period === 2 && e.minute >= 80;
      const score = 70 + bonus + (late ? 8 : 0) + (isWinner ? 10 : 0) + (xg < 0.08 && !pen ? 4 : 0);

      const how = pen
        ? `from the penalty spot after ${pname(foul?.playerId)}'s foul on ${pname(foul?.otherPlayerId)}`
        : `from ${dist} metres, ${chanceWord(xg)} (${r2(xg)} xG)`;
      const setup = assist
        ? ` ${pname(assist.playerId)} set it up with a ${difficultyWord(assist.passDifficulty ?? 0)} pass (difficulty ${r2(assist.passDifficulty ?? 0)}).`
        : "";
      add({
        type: "goal", seq: e.seq, seqFrom: assist?.seq ?? foul?.seq ?? e.seq, seqTo: e.seq, teamId: e.teamId, playerId: e.playerId,
        score,
        headline: `Goal: ${shooter} (${team})`,
        reason: `${shooter} ${label} for ${team} in the ${formatClock(e)}, ${how}. It makes it ${nowHome}-${nowAway}.${setup}${isWinner ? " It turns out to be the winning goal." : ""}`,
        evidence: [assist?.id, foul?.id, e.id].filter((x): x is string => !!x),
        facts: {
          scorer: shooter, team, xg: r2(xg), distanceM: dist, penalty: pen, scoreHome: nowHome, scoreAway: nowAway,
          situation: label, winningGoal: isWinner, ...(assist ? { assistBy: pname(assist.playerId), assistDifficulty: r2(assist.passDifficulty ?? 0) } : {}),
        },
      });
      momentShots.add(e.seq);
      return;
    }

    if (pen) {
      const foul = precedingFoul(i, other(e.teamId));
      const fate = e.outcome === "saved" ? `saved by ${gkName(other(e.teamId))}` : e.outcome === "post" ? "hits the post" : "goes wide";
      add({
        type: "penalty_miss", seq: e.seq, seqFrom: foul?.seq ?? e.seq, seqTo: e.seq, teamId: e.teamId, playerId: e.playerId,
        score: 72,
        headline: `Penalty missed: ${shooter} (${team})`,
        reason: `${shooter} has a penalty for ${team} in the ${formatClock(e)} (about ${Math.round(xg * 100)}% to score) but it ${fate}.`,
        evidence: [foul?.id, e.id].filter((x): x is string => !!x),
        facts: { player: shooter, team, xg: r2(xg), outcome: e.outcome ?? "" },
      });
      momentShots.add(e.seq);
      return;
    }

    if (xg >= o.bigChanceXg) {
      const fate =
        e.outcome === "saved" ? `${gkName(other(e.teamId))} saves it`
        : e.outcome === "post" ? "it hits the post"
        : e.outcome === "blocked" ? "it is blocked"
        : "it goes off target";
      add({
        type: "big_chance", seq: e.seq, seqFrom: e.seq, seqTo: e.seq, teamId: e.teamId, playerId: e.playerId,
        score: 34 + xg * 45 + (e.outcome === "post" ? 8 : 0),
        headline: `Big chance missed: ${shooter} (${team})`,
        reason: `${shooter} gets a big chance for ${team} in the ${formatClock(e)} from ${dist} metres, ${chanceWord(xg)} (${r2(xg)} xG), but ${fate}.`,
        evidence: [e.id],
        facts: { player: shooter, team, xg: r2(xg), distanceM: dist, outcome: e.outcome ?? "" },
      });
      momentShots.add(e.seq);
    }
  });

  // ---------- manager's call: a tired player left on the pitch ----------
  const subOff = new Map<Id, MatchEvent>();
  const sentOff = new Set<Id>();
  for (const e of ev) {
    if (e.type === "substitution" && e.playerId) subOff.set(e.playerId, e);
    if (e.type === "card" && e.cardColor === "red" && e.playerId) sentOff.add(e.playerId);
  }
  const lastEvent = ev[ev.length - 1];
  const endSec = lastEvent ? ctx.clock.playSec(lastEvent) : 0;
  const energyByPlayer = new Map<Id, { minute: number; energy: number }[]>();
  for (const f of ctx.fatigue) {
    const list = energyByPlayer.get(f.playerId) ?? [];
    list.push({ minute: f.minute, energy: f.energy });
    energyByPlayer.set(f.playerId, list);
  }

  for (const [playerId, samples] of energyByPlayer) {
    const player = ctx.players.get(playerId);
    if (!player || player.position === "GK" || sentOff.has(playerId)) continue;
    samples.sort((a, b) => a.minute - b.minute);
    const first = samples.find((s) => s.energy < o.energyThreshold);
    if (!first) continue;
    const flagSec = first.minute * 60;
    const off = subOff.get(playerId);
    const offSec = off ? ctx.clock.playSec(off) : endSec;
    const stayMin = (offSec - flagSec) / 60;
    if (stayMin < o.minStayMinutes) continue;

    const teamId = player.teamId;
    const inWindow = ev.filter((e) => {
      const s = ctx.clock.playSec(e);
      return s >= flagSec && s <= offSec;
    });
    if (inWindow.length === 0) continue;
    const anchor = inWindow[0];
    const oppShots = inWindow.filter((e) => e.type === "shot" && e.teamId === other(teamId));
    const oppXg = oppShots.reduce((a, e) => a + (e.xg ?? 0), 0);
    const conceded = oppShots.filter((e) => e.outcome === "goal");
    const passes = (from: number, to: number) => ev.filter((e) => e.type === "pass" && e.playerId === playerId && ctx.clock.playSec(e) >= from && ctx.clock.playSec(e) < to);
    const before = passes(0, flagSec);
    const after = passes(flagSec, offSec + 1);
    const acc = (ps: MatchEvent[]) => Math.round((ps.filter((p) => p.outcome === "success").length / ps.length) * 100);
    const hasPassTrend = before.length >= 8 && after.length >= 4;
    const accBefore = hasPassTrend ? acc(before) : undefined;
    const accAfter = hasPassTrend ? acc(after) : undefined;
    const energyPct = Math.round(first.energy * 100);

    const parts: string[] = [];
    parts.push(`${player.name} (${tname(teamId)}) was down to ${energyPct}% energy by the ${formatClock(anchor)}`);
    parts.push(
      off ? `and stayed on for ${Math.round(stayMin)} more minutes until ${pname(off.otherPlayerId)} replaced him in the ${formatClock(off)}`
      : ctx.complete ? `and stayed on until the final whistle, ${Math.round(stayMin)} more minutes`
      : `and was still on the pitch ${Math.round(stayMin)} minutes later`,
    );
    let reason = `${parts.join(" ")}.`;
    const passingDropped = accBefore !== undefined && accAfter !== undefined && accBefore - accAfter >= 5;
    if (passingDropped) reason += ` His pass accuracy fell from ${accBefore}% to ${accAfter}%.`;
    reason += ` In that spell ${tname(other(teamId))} had ${oppShots.length} shot${oppShots.length === 1 ? "" : "s"} worth ${r2(oppXg)} xG${conceded.length ? ` and scored ${conceded.length}` : ""}.`;

    add({
      type: "manager_call", seq: anchor.seq, seqFrom: anchor.seq, seqTo: (off ?? inWindow[inWindow.length - 1]).seq,
      teamId, playerId,
      score: 50 + Math.min(20, stayMin * 1.5) + (oppXg >= 0.5 ? 10 : 0) + (conceded.length ? 15 : 0) + (passingDropped ? 6 : 0),
      headline: `Manager's call: ${player.name} left on at ${energyPct}% energy`,
      reason,
      evidence: [anchor.id, ...(off ? [off.id] : []), ...conceded.map((c) => c.id)],
      facts: {
        player: player.name, team: tname(teamId), energyPct, stayMinutes: Math.round(stayMin), replaced: !!off,
        ...(off ? { replacedBy: pname(off.otherPlayerId), replacedAt: formatClock(off) } : {}),
        opponentShots: oppShots.length, opponentXg: r2(oppXg), goalsConceded: conceded.length,
        ...(accBefore !== undefined && accAfter !== undefined ? { passAccuracyBefore: accBefore, passAccuracyAfter: accAfter } : {}),
      },
    });
  }

  for (const team of [homeId, awayId]) {
    const calls = moments.filter((m) => m.type === "manager_call" && m.teamId === team).sort((a, b) => b.score - a.score);
    for (const extra of calls.slice(o.maxCallsPerTeam)) moments.splice(moments.indexOf(extra), 1);
  }

  // ---------- momentum shifts, pressing spells ----------
  const bins = threatBins(ctx);
  const W = o.shiftWindow;
  let skipUntil = -1;
  for (let i = 2 * W - 1; i < bins.home.length; i++) {
    if (i < skipUntil) continue;
    const nowH = sum(bins.home, i - W + 1, i), nowA = sum(bins.away, i - W + 1, i);
    const prevH = sum(bins.home, i - 2 * W + 1, i - W), prevA = sum(bins.away, i - 2 * W + 1, i - W);
    if (nowH + nowA < o.shiftMinThreat || prevH + prevA < o.shiftMinThreat) continue;
    const nowShare = nowH / (nowH + nowA);
    const prevShare = prevH / (prevH + prevA);
    let team: Id | null = null;
    if (prevShare <= 0.5 - o.shiftGap / 2 && nowShare >= 0.5 + o.shiftGap / 2) team = homeId;
    else if (prevShare >= 0.5 + o.shiftGap / 2 && nowShare <= 0.5 - o.shiftGap / 2) team = awayId;
    if (!team) continue;

    const share = (s: number) => Math.round((team === homeId ? s : 1 - s) * 100);
    const windowEvents = bins.events.slice(i - W + 1, i + 1).flat();
    const shots = windowEvents.filter((e) => e.type === "shot" && e.teamId === team);
    const xg = shots.reduce((a, e) => a + (e.xg ?? 0), 0);
    const top = windowEvents.filter((e) => e.teamId === team && threatOf(e) > 0).sort((a, b) => threatOf(b) - threatOf(a)).slice(0, 3);
    if (windowEvents.length === 0) continue; // a quiet stretch with no events at all
    const anchor = windowEvents[windowEvents.length - 1];
    const startEvent = windowEvents[0];
    add({
      type: "momentum_shift", seq: anchor.seq, seqFrom: startEvent.seq, seqTo: anchor.seq, teamId: team,
      score: 38 + Math.abs(nowShare - prevShare) * 40 + Math.min(10, shots.length * 2),
      headline: `Momentum swings to ${tname(team)}`,
      reason: `${tname(team)} took control: between the ${formatClock(startEvent)} and ${formatClock(anchor)} they produced ${share(nowShare)}% of the attacking threat, up from ${share(prevShare)}% in the previous ${W} minutes, with ${shots.length} shot${shots.length === 1 ? "" : "s"} worth ${r2(xg)} xG.`,
      evidence: (shots.length ? shots : top).slice(0, 4).map((e) => e.id),
      facts: { team: tname(team), shareBefore: share(prevShare), shareNow: share(nowShare), windowMinutes: W, shots: shots.length, xg: r2(xg) },
    });
    skipUntil = i + W + 2;
  }

  for (const team of [homeId, awayId]) {
    const perBin = bins.events.map((es) => es.filter((e) => e.type === "pressure" && e.teamId === team).length);
    const wonHigh = bins.events.map((es) => es.filter((e) => e.type === "possession_change" && e.teamId === team && e.x >= 55).length);
    let skip = -1;
    for (let i = 4; i < perBin.length; i++) {
      if (i < skip) continue;
      const press = sum(perBin, i - 4, i);
      const high = sum(wonHigh, i - 4, i);
      if (press < o.minPressures || high < o.minHighTurnovers) continue;
      const windowEvents = bins.events.slice(i - 4, i + 1).flat();
      const shots = windowEvents.filter((e) => e.type === "shot" && e.teamId === team);
      const turnovers = windowEvents.filter((e) => e.type === "possession_change" && e.teamId === team && e.x >= 55);
      const first = windowEvents[0];
      const lastE = windowEvents[windowEvents.length - 1];
      add({
        type: "press_spell", seq: lastE.seq, seqFrom: first.seq, seqTo: lastE.seq, teamId: team,
        score: 33 + high * 4 + shots.length * 3,
        headline: `Pressing spell: ${tname(team)}`,
        reason: `${tname(team)} pressed hard between the ${formatClock(first)} and ${formatClock(lastE)}: ${press} pressure actions, winning the ball back ${high} times in the opponent's half${shots.length ? ` and taking ${shots.length} shot${shots.length === 1 ? "" : "s"}` : " without turning it into a shot"}.`,
        evidence: [...turnovers.slice(0, 4), ...shots.slice(0, 2)].map((e) => e.id),
        facts: { team: tname(team), pressures: press, ballsWonHigh: high, shots: shots.length },
      });
      skip = i + 8;
    }
  }

  // ---------- control spells: long unbroken passing sequences ----------
  const runs: MatchEvent[][] = [];
  let run: MatchEvent[] = [];
  let runTeam: Id | null = null;
  const flush = () => { if (run.length >= o.minControlPasses) runs.push(run); run = []; runTeam = null; };
  for (const e of ev) {
    if (e.type === "pressure") continue;
    if (e.type === "pass" && e.outcome === "success") {
      if (runTeam !== null && e.teamId !== runTeam) flush();
      runTeam = e.teamId;
      run.push(e);
    } else flush();
  }
  flush();
  runs.sort((a, b) => b.length - a.length).slice(0, 3).forEach((r) => {
    const first = r[0], last = r[r.length - 1];
    const seconds = Math.round(ctx.clock.playSec(last) - ctx.clock.playSec(first));
    const team = first.teamId;
    add({
      type: "control_spell", seq: last.seq, seqFrom: first.seq, seqTo: last.seq, teamId: team,
      score: 28 + Math.min(27, (r.length - o.minControlPasses) * 2.5),
      headline: `Control: ${tname(team)} keep the ball`,
      reason: `${tname(team)} strung together ${r.length} passes in a row over ${seconds} seconds, from the ${formatClock(first)} to the ${formatClock(last)}, without losing the ball.`,
      evidence: [first.id, last.id],
      facts: { team: tname(team), passes: r.length, seconds },
    });
  });

  // ---------- key passes: a difficult pass that leads straight to a shot ----------
  ev.forEach((p, i) => {
    if (p.type !== "pass" || p.outcome !== "success" || (p.passDifficulty ?? 0) < o.keyPassDifficulty) return;
    for (let j = i + 1; j <= Math.min(ev.length - 1, i + 3); j++) {
      const s = ev[j];
      if (s.type === "shot" && s.teamId === p.teamId && s.playerId === p.otherPlayerId) {
        if (momentShots.has(s.seq)) return;
        const d = p.passDifficulty ?? 0;
        add({
          type: "key_pass", seq: p.seq, seqFrom: p.seq, seqTo: s.seq, teamId: p.teamId, playerId: p.playerId,
          score: 26 + d * 20,
          headline: `Key pass: ${pname(p.playerId)} to ${pname(p.otherPlayerId)}`,
          reason: `${pname(p.playerId)}'s ${difficultyWord(d)} pass (difficulty ${r2(d)}, ${r1(p.passDistance ?? 0)} metres) in the ${formatClock(p)} found ${pname(p.otherPlayerId)}, who shot straight away${s.outcome === "saved" ? " and was denied by the keeper" : s.outcome === "off_target" ? " but missed the target" : s.outcome === "blocked" ? " but was blocked" : ""}.`,
          evidence: [p.id, s.id],
          facts: { passer: pname(p.playerId), receiver: pname(p.otherPlayerId), difficulty: r2(d), distanceM: r1(p.passDistance ?? 0), shotOutcome: s.outcome ?? "" },
        });
        return;
      }
    }
  });

  void indexOfSeq;
  return moments.sort((a, b) => a.seq - b.seq || a.type.localeCompare(b.type));
}

/** The N most important moments, in match order. */
export function topMoments(moments: KeyMoment[], n: number): KeyMoment[] {
  return [...moments].sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.seq - b.seq);
}

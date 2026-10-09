// src/lib/simulator/fixtures.ts
// Builds a full double round-robin season (circle method): 20 teams -> 38 rounds, 10 matches each.

export interface Fixture {
  round: number;       // 1-38
  index: number;       // 0-9, position within the round
  homeTeamId: string;
  awayTeamId: string;
}

export function roundRobin(teamIds: string[]): Fixture[] {
  const n = teamIds.length;
  if (n < 2 || n % 2 !== 0) throw new Error("Need an even number of teams");

  const fixed = teamIds[0];
  let rotating = teamIds.slice(1);
  const firstHalf: Fixture[] = [];

  for (let k = 0; k < n - 1; k++) {
    const list = [fixed, ...rotating];
    for (let i = 0; i < n / 2; i++) {
      let home = list[i];
      let away = list[n - 1 - i];
      if (k % 2 === 1) [home, away] = [away, home]; // alternate home and away round by round
      firstHalf.push({ round: k + 1, index: i, homeTeamId: home, awayTeamId: away });
    }
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }

  // Second half of the season: same pairings, home and away swapped.
  const secondHalf = firstHalf.map((f) => ({
    round: f.round + (n - 1),
    index: f.index,
    homeTeamId: f.awayTeamId,
    awayTeamId: f.homeTeamId,
  }));

  return [...firstHalf, ...secondHalf];
}
import type { Player, Position, Team } from "../datasource/types";
import { between, pick, rng, shuffle } from "./rng";

const CLUBS = [
  "Kingsmere", "Ravenholt", "Dunmore", "Stonebrook", "Wexcombe",
  "Marlowe Vale", "Thornfield", "Calderbank", "Westhaven", "Pinecrest",
  "Redmarsh", "Silverlake", "Oakhurst", "Brightwater", "Ironcliffe",
  "Fairhaven", "Lindenfell", "Highmoor", "Sandport", "Greystone",
];
const SUFFIXES = ["FC", "United", "Athletic", "Town"] as const;
const STYLES: Team["style"][] = ["high_press", "possession", "counter", "direct"];

const FIRST = [
  "Adam", "Bruno", "Callum", "Diego", "Emeka", "Felix", "Gabriel", "Hamza",
  "Ivan", "Jamal", "Kofi", "Liam", "Mateo", "Nico", "Omar", "Pedro",
  "Quinn", "Rafael", "Samir", "Tomas", "Uche", "Victor", "Wesley", "Yusuf",
];
const LAST = [
  "Adeyemi", "Bakker", "Castillo", "Dalton", "Eze", "Fraser", "Gomez", "Haddad",
  "Ibrahim", "Jensen", "Keita", "Lopez", "Mensah", "Novak", "Okafor", "Petrov",
  "Quaye", "Rossi", "Silva", "Tanaka", "Umar", "Vargas", "Walker", "Yilmaz",
];

// 23-player squad: 3 GK, 8 DF, 7 MF, 5 FW
const SQUAD_SHAPE: Position[] = [
  ...Array<Position>(3).fill("GK"),
  ...Array<Position>(8).fill("DF"),
  ...Array<Position>(7).fill("MF"),
  ...Array<Position>(5).fill("FW"),
];

export interface League {
  teams: Team[];
  players: Player[];
}

export function generateLeague(seed = 2026): League {
  const r = rng(seed);
  const styles = shuffle(r, STYLES.flatMap((s) => Array(5).fill(s) as Team["style"][]));

  const teams: Team[] = CLUBS.map((club, i) => ({
    id: `t${String(i + 1).padStart(2, "0")}`,
    name: `${club} ${pick(r, SUFFIXES)}`,
    shortName: club.replace(/\s/g, "").slice(0, 3).toUpperCase(),
    colorPrimary: `hsl(${i * 18}, 65%, 40%)`,
    colorSecondary: i % 2 === 0 ? "#ffffff" : "#111111",
    style: styles[i],
  }));

  const players: Player[] = [];
  teams.forEach((team) => {
    const strength = between(r, 0.45, 0.75); // team quality baseline
    const usedNames = new Set<string>();
    SQUAD_SHAPE.forEach((position, idx) => {
      let name = "";
      do {
        name = `${pick(r, FIRST)} ${pick(r, LAST)}`;
      } while (usedNames.has(name));
      usedNames.add(name);

      players.push({
        id: `${team.id}p${String(idx + 1).padStart(2, "0")}`,
        teamId: team.id,
        name,
        shirtNumber: idx + 1,
        position,
        stamina: Math.round(between(r, 0.55, 0.95) * 100) / 100,
        quality: Math.round(Math.min(0.95, Math.max(0.3, strength + between(r, -0.15, 0.2))) * 100) / 100,
      });
    });
  });

  return { teams, players };
}
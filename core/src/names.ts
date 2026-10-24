// A name a human can hold in their head, so that with several negotiations
// running at once, every Telegram message, page and agent reply about the same
// room carries the same "🦊 Amber Fox". Derived from the room id rather than
// stored: it is a label for people, not an identifier — two rooms may share one.

// biome-ignore format: a grid reads better than one word per line
const ADJECTIVES = [
  "Amber", "Silver", "Velvet", "Copper", "Misty", "Golden", "Scarlet", "Ivory",
  "Jade", "Coral", "Indigo", "Sunny", "Frosty", "Mossy", "Rusty", "Lucky",
  "Gentle", "Brave", "Swift", "Sleepy", "Clever", "Merry", "Noble", "Polar",
  "Cosmic", "Dusty", "Hazel", "Crimson", "Olive", "Pearl", "Quiet", "Bold",
  "Breezy", "Cozy", "Dapper", "Fuzzy", "Jolly", "Lunar", "Plucky", "Rosy",
] as const;

// biome-ignore format: a grid reads better than one word per line
const ANIMALS = [
  ["🦊", "Fox"], ["🦉", "Owl"], ["🐋", "Whale"], ["🦦", "Otter"], ["🦩", "Flamingo"],
  ["🐼", "Panda"], ["🐯", "Tiger"], ["🐨", "Koala"], ["🐧", "Penguin"], ["🐬", "Dolphin"],
  ["🐢", "Turtle"], ["🦔", "Hedgehog"], ["🐰", "Rabbit"], ["🦡", "Badger"], ["🦫", "Beaver"],
  ["🦬", "Bison"], ["🦁", "Lion"], ["🐺", "Wolf"], ["🐻", "Bear"], ["🦌", "Deer"],
  ["🦢", "Swan"], ["🦜", "Parrot"], ["🦚", "Peacock"], ["🐙", "Octopus"], ["🦋", "Butterfly"],
  ["🐌", "Snail"], ["🦝", "Raccoon"], ["🦥", "Sloth"], ["🦓", "Zebra"], ["🦒", "Giraffe"],
  ["🦛", "Hippo"], ["🐫", "Camel"], ["🦙", "Llama"], ["🐸", "Frog"], ["🐝", "Bee"],
  ["🦀", "Crab"], ["🐞", "Ladybird"], ["🦘", "Kangaroo"], ["🐿️", "Squirrel"], ["🦄", "Unicorn"],
] as const;

/** FNV-1a: the same room gets the same name on every deploy. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export interface RoomName {
  emoji: string;
  /** "Amber Fox" */
  name: string;
}

export function roomName(roomId: string): RoomName {
  const h = hash(roomId);
  const adjective = ADJECTIVES[h % ADJECTIVES.length]!;
  const [emoji, animal] = ANIMALS[Math.floor(h / ADJECTIVES.length) % ANIMALS.length]!;
  return { emoji, name: `${adjective} ${animal}` };
}

/** "🦊 Amber Fox", as agents and pages show it. */
export function roomLabel(roomId: string): string {
  const { emoji, name } = roomName(roomId);
  return `${emoji} ${name}`;
}

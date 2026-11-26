export const METHODS: Record<string, string> = { email: 'Email link', password: 'Password', passkey: 'Passkey', github: 'GitHub', google: 'Google' };
export const methodLabel = (method: string) => Object.hasOwn(METHODS, method) ? METHODS[method] : method;

export const ordered = (saved: string[], known: Record<string, string>): [string, string][] => [
  ...saved.map((value): [string, string] => [value, Object.hasOwn(known, value) ? known[value] : value]),
  ...Object.entries(known).filter(([value]) => !saved.includes(value)),
];


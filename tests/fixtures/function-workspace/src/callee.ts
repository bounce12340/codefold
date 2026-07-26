export function formatName(name: string): string {
  return name.trim();
}

export class Greeter {
  greet(name: string): string {
    return formatName(name);
  }
}

export const makeGreeting = (name: string): string => {
  return new Greeter().greet(name);
};

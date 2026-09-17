declare module "bestzip" {
  export default function zip(config: {
    source: string | string[];
    destination: string;
    cwd?: string;
  }): Promise<void>;
}

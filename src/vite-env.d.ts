declare module "*.svg" {
  const src: string;
  export default src;
}

/** Side-effect stylesheet imports (Vite injects them). */
declare module "*.css";

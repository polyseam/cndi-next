import { Command, TerminalSpinner } from "deps";
import { emitExitEvent } from "src/utils.ts";

// deno-lint-ignore no-explicit-any
const owAction = (args: any) => {
  if(!args.initializing){
    console.log(`cndi overwrite --file "${args.file}"\n`);
  }
  const spinner = new TerminalSpinner({
    // text: "",
    color: "cyan",
    spinner:{
      "interval": 80,
      "frames": [
        "▰▱▱▱▱▱▱",
        "▰▰▱▱▱▱▱",
        "▰▰▰▱▱▱▱",
        "▰▰▰▰▱▱▱",
        "▰▰▰▰▰▱▱",
        "▰▰▰▰▰▰▱",
        "▰▰▰▰▰▰▰",
        "▰▱▱▱▱▱▱",
      ]
    },
    writer: Deno.stdout,
  });

  spinner.start();

  const w = new Worker(import.meta.resolve("src/actions/overwrite.worker.ts"), {
    type: "module",
  });

  w.postMessage({ args, type: "begin-overwrite" });

  w.onmessage = async (e) => {
    console.log()
    if (e.data.type === "complete-overwrite") {
      w.terminate();
      spinner.stop();
      await emitExitEvent(0);
      Deno.exit(0);
    } else if(e.data.type==="error-overwrite"){
      w.terminate();
      await emitExitEvent(e.data.code);
      Deno.exit(e.data.code);
    }
  };
};

/**
 * COMMAND cndi overwrite
 * Creates a CNDI cluster by reading the contents of ./cndi
 */
const overwriteCommand = new Command()
  .description(`Update cndi project files using cndi_config.yaml file.`)
  .alias("ow")
  .option("-f, --file <file:string>", "Path to your cndi_config file.")
  .option(
    "-o, --output <output:string>",
    "Path to your cndi cluster git repository.",
    {
      default: Deno.cwd(),
    },
  )
  .option(
    "--initializing <initializing:boolean>",
    'true if "cndi init" is the caller of this command',
    { hidden: true, default: false },
  )
  .action(owAction);

export { overwriteCommand, owAction };

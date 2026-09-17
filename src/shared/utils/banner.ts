import figlet from "figlet";

export async function printBanner(title: string) {
  if (!process.stdout.isTTY) {
    console.log(title);
    return;
  }

  try {
    const banner = await figlet.text(title, {
      font: "Standard",
      horizontalLayout: "default",
      verticalLayout: "default",
      width: 80,
      whitespaceBreak: true,
    });
    console.log(banner);
  } catch {
    console.log(title);
  }
}

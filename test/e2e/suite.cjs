const assert = require("node:assert/strict");
const Mocha = require("mocha");
const vscode = require("vscode");

// Derive the id rather than hard-coding it: renaming the publisher or the
// extension would otherwise leave this looking up something that no longer
// exists, and report it as the extension failing to load.
const manifest = require("../../package.json");
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

function run() {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 30_000 });
  mocha.suite.emit("pre-require", global, __filename, mocha);

  suite("Rostrum Extension Development Host", () => {
    test("activates and exposes its core commands", async () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(extension, `${EXTENSION_ID} should be loaded as the extension under test`);
      await extension.activate();
      assert.equal(extension.isActive, true);

      const commands = await vscode.commands.getCommands(true);
      for (const command of [
        "rostrum.newSession",
        "rostrum.cancel",
        "rostrum.pickAgent",
        "rostrum.searchSessions",
        "rostrum.retryRecovery",
        "rostrum.agentDiagnostics",
      ]) {
        assert.ok(commands.includes(command), `missing command: ${command}`);
      }
    });
  });

  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed.`)) : resolve()));
  });
}

module.exports = { run };

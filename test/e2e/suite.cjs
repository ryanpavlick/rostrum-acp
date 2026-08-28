const assert = require("node:assert/strict");
const Mocha = require("mocha");
const vscode = require("vscode");

// Derive the id rather than hard-coding it: renaming the publisher or the
// extension would otherwise leave this looking up something that no longer
// exists, and report it as the extension failing to load.
const manifest = require("../../package.json");
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;
const contributes = manifest.contributes;

/**
 * A tree row as the Sessions view actually produces one. Context-menu
 * commands are handed this, never the id a palette invocation passes, and
 * handlers written for only one shape fail silently on the other.
 */
const storedNode = (sessionId) => ({ type: "stored", session: { sessionId, title: "t", agentKey: "a" } });

function run() {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: 60_000 });
  mocha.suite.emit("pre-require", global, __filename, mocha);

  suite("Rostrum Extension Development Host", () => {
    suiteSetup(async () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      assert.ok(extension, `${EXTENSION_ID} should be loaded as the extension under test`);
      await extension.activate();
      assert.equal(extension.isActive, true);
    });

    test("activates and exposes its core commands", async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const command of [
        "rostrum.newSession",
        "rostrum.cancel",
        "rostrum.pickAgent",
        "rostrum.searchSessions",
        "rostrum.retryRecovery",
        "rostrum.agentDiagnostics",
        "rostrum.clearLocalData",
        "rostrum.attachActiveFile",
        "rostrum.attachSelection",
        "rostrum.attachDiagnostics",
        "rostrum.attachOpenEditors",
        "rostrum.attachWorkspaceLayout",
      ]) {
        assert.ok(commands.includes(command), `missing command: ${command}`);
      }
    });

    test("every contributed command is registered in the running host", async () => {
      // The manifest check reads the source; this one asks VS Code, which is
      // the only thing that knows what actually got registered at activation.
      const commands = new Set(await vscode.commands.getCommands(true));
      const missing = contributes.commands
        .map((entry) => entry.command)
        .filter((command) => !commands.has(command));
      assert.deepEqual(missing, [], `contributed but not registered at runtime: ${missing.join(", ")}`);
    });

    test("commands reachable from a tree row accept a tree row", async () => {
      // Invoking with the node shape the view produces must not throw. This
      // does not prove the command did the right thing — a modal confirm stops
      // us going further — but a handler that mishandles the argument tends to
      // throw here, and one that ignores it entirely is caught by the manifest
      // check instead.
      const entries = (contributes.menus?.["view/item/context"] ?? []).filter(
        (item) => item.when?.includes("rostrum.session"),
      );
      assert.ok(entries.length > 0, "there are session context-menu commands to exercise");

      for (const { command } of entries) {
        // An id that exists nowhere: the command should decline it cleanly
        // rather than fail on the shape of the argument.
        let failure;
        try {
          await vscode.commands.executeCommand(command, storedNode("no-such-session"));
        } catch (error) {
          failure = error;
        }

        if (!failure) continue;

        // A test host refuses modal dialogs outright. Reaching that refusal is
        // itself the evidence we want: the command resolved the tree node and
        // got as far as asking the user to confirm. Anything else is the
        // handler failing on the argument.
        assert.match(
          String(failure.message ?? failure),
          /refused to show dialog in tests/,
          `${command} failed on the tree node it is contributed for: ${failure}`,
        );
      }
    });

    test("settings the manifest promises can actually be read", async () => {
      const config = vscode.workspace.getConfiguration("rostrum");
      for (const key of Object.keys(contributes.configuration?.properties ?? {})) {
        const short = key.replace(/^rostrum\./, "");
        // `inspect` returning undefined means VS Code does not know the
        // setting at all, which is the manifest and the schema disagreeing.
        assert.ok(config.inspect(short), `${key} is contributed but unknown to VS Code`);
      }
    });

    test("declared workspace restrictions survive packaging", async () => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      const caps = extension.packageJSON.capabilities ?? {};
      assert.equal(caps.untrustedWorkspaces?.supported, false, "agents run commands; untrusted must stay unsupported");
      assert.equal(caps.virtualWorkspaces?.supported, false, "agents are local processes editing files on disk");
    });

    test("the diagnostics report runs against no agent without failing", async () => {
      // Exercised because it is the command a beta user is asked to run when
      // reporting a compatibility problem, and it must not itself be broken.
      await assert.doesNotReject(
        () => Promise.resolve(vscode.commands.executeCommand("rostrum.agentDiagnostics")),
      );
    });
  });

  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed.`)) : resolve()));
  });
}

module.exports = { run };

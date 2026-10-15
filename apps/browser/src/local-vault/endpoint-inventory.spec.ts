import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

import { isAnswered } from "../../local-vault-rs/pkg";

const REPOSITORY = join(__dirname, "..", "..", "..", "..");
const SOURCE_DIRECTORIES = ["libs", join("apps", "browser", "src")];
const SOME_ID = "00000000-0000-4000-8000-000000000000";
const OPTIONS_LENGTH = 600;
const ANSWERED = "answered";
const REFUSED = "refused";
const NOT_KNOWN = "not known: the path is put together when the request is made";
const SDK_FILE = "node_modules/@bitwarden/sdk-internal/bitwarden_wasm_internal_bg.wasm";

/**
 * A path the way the SDK has it for a request: words in lower case, with hyphens. What stands
 * right before and after it tells it from a part of something longer, such as the name of a file.
 */
const SDK_PATH = /(?<![A-Za-z0-9_./{}-])(?:\/[a-z][a-z0-9-]*)+(?![A-Za-z0-9_.-])/g;

/** Where the SDK was built is in it as well, and is not the path of a request. */
const BUILD_DIRECTORIES = ["home", "rustc", "root", "usr", "tmp", "var", "opt", "build"];

/**
 * Every request that the code of the extension can make to a Bitwarden server, by what the local
 * server does with it, as the route table of the local vault has it (`isAnswered`): it answers
 * the request, or it refuses it as a feature that needs a server.
 *
 * This fails when an update from upstream adds, changes or removes a request. Look at each
 * line that changed, and decide whether the local server has to answer the request:
 *
 * - A request that was added is refused until the local vault (`local-vault-rs`) has a route
 *   for it, which the Android app then has as well. That is right for everything that is about
 *   other people (organizations, Sends, sharing), about a subscription or about signing in
 *   without a master password.
 * - A request that disappeared may have moved into the Bitwarden SDK, which makes it by itself.
 *   The local server still has to answer it: see `routes that the code does not show` below.
 *
 * Then update the snapshot: `npm test -- endpoint-inventory -u`.
 */
describe("the requests that the extension can make", () => {
  let inventory: Record<string, string>;

  beforeAll(() => {
    inventory = {};
    for (const endpoint of findEndpoints()) {
      inventory[endpoint] = disposition(endpoint);
    }
  });

  function requests(recorded: string): string[] {
    return Object.keys(inventory).filter((endpoint) => inventory[endpoint] === recorded);
  }

  it("are found in the code", () => {
    expect(Object.keys(inventory).length).toBeGreaterThan(100);
  });

  /**
   * The short list: what the local server does for the app. A line that goes from it is a
   * request that the app no longer makes this way, or a route that was lost.
   */
  it("are answered by the local server where that is recorded", () => {
    expect(requests(ANSWERED)).toMatchSnapshot();
  });

  /**
   * The long list, most of which the extension never asks for: it comes with the libraries that
   * the web vault shares. A line that is added is where a route may be missing.
   */
  it("are refused by the local server where that is recorded", () => {
    expect(requests(REFUSED)).toMatchSnapshot();
  });

  it("cannot be told from the code where that is recorded", () => {
    expect(requests(NOT_KNOWN)).toMatchSnapshot();
  });

  /**
   * Requests that the local server answers although no call in the code of the extension shows
   * them: the Bitwarden SDK makes them by itself, or only another client makes them. A request
   * that the SDK takes over from the code of the extension belongs here.
   */
  it.each([
    // Made by the SDK: moving items to a folder, recording the ID of the user key, and changing
    // how the master key is derived.
    ["PUT", "ciphers/move"],
    ["POST", "accounts/key-management/user-key-id"],
    ["POST", "accounts/kdf"],
    // Made by the Android app, which shares the route table.
    ["POST", "accounts/prelogin"],
    ["PUT", `ciphers/${SOME_ID}/archive`],
    ["PUT", `ciphers/${SOME_ID}/unarchive`],
    ["GET", "ciphers/has-unassigned-ciphers"],
    ["GET", "auth-requests"],
    ["PUT", `devices/identifier/${SOME_ID}/token`],
  ])("answers %s %s, as one of the routes that the code does not show", (method, path) => {
    expect(disposition(`${method} /${path}`)).toBe(ANSWERED);
  });
});

/**
 * The paths that the Bitwarden SDK has in it. The SDK makes its requests by itself, so the code
 * of the extension does not show them: they are read from the SDK as it is installed. What is
 * found is every text in it that looks like a path, which is more than its requests, and has
 * the parts of a path that the SDK puts together (`/ciphers` and `/partial`) one by one.
 *
 * This fails when an update of the SDK adds or removes a path. A path that was added is a
 * request that the SDK may start to make: find what makes it, and whether the app does that
 * without a feature flag. If so, the local server needs a route, as for `PUT ciphers/move`, and
 * `local-sdk-client.spec.ts` a test that it is the right one.
 *
 * Then update the snapshot: `npm test -- endpoint-inventory -u`.
 */
describe("the requests that the Bitwarden SDK can make by itself", () => {
  it("go to the paths that are recorded", () => {
    const paths = findSdkPaths();

    // The ones that the local server is known to be asked for.
    expect(paths).toEqual(
      expect.arrayContaining(["/ciphers/move", "/accounts/key-management/user-key-id"]),
    );
    expect(paths).toMatchSnapshot();
  });
});

/**
 * What the local server does with the request of an inventory line.
 */
function disposition(endpoint: string): string {
  const [method, template] = endpoint.split(" ");
  // What comes before the first `/` is the address of the service, which is not part of the path.
  const path = template.replace(/^\{\}(?=\/)/, "").replace(/\{\}/g, SOME_ID);
  if (!path.startsWith("/")) {
    return NOT_KNOWN;
  }
  const segments = path.split("/").filter((segment) => segment !== "");
  return isAnswered(method, segments) ? ANSWERED : REFUSED;
}

/**
 * Finds the texts in the SDK that look like the path of a request.
 */
function findSdkPaths(): string[] {
  // Every byte as one character, so that what is not text does not get in the way.
  const sdk = readFileSync(join(REPOSITORY, SDK_FILE)).toString("latin1");
  const paths = new Set<string>();
  for (const match of sdk.matchAll(SDK_PATH)) {
    const first = match[0].split("/")[1];
    // What is this short comes from what is not text.
    if (first.length > 2 && !BUILD_DIRECTORIES.includes(first)) {
      paths.add(match[0]);
    }
  }
  return [...paths].sort();
}

/**
 * Finds the requests in the code: the calls of `ApiService.send` with their method and path, and
 * the requests that are built for `ApiService.fetch`. A part of a path that is not written out
 * shows as `{}`.
 */
function findEndpoints(): string[] {
  const endpoints = new Set<string>();
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/\.send\(\s*"(GET|POST|PUT|DELETE|PATCH)",\s*/g)) {
      const expression = argumentAt(source, match.index + match[0].length);
      endpoints.add(`${match[1]} ${toPath(resolveVariable(source, match.index, expression))}`);
    }
    for (const match of source.matchAll(/\.createRequest\(\s*/g)) {
      const expression = argumentAt(source, match.index + match[0].length);
      // The method is one of the options that follow the address.
      const options = source.substring(match.index, match.index + OPTIONS_LENGTH);
      const method = /method:\s*"(GET|POST|PUT|DELETE|PATCH)"/.exec(options)?.[1];
      if (/["`]/.test(expression) && method != null) {
        endpoints.add(`${method} ${toPath(expression)}`);
      }
    }
  }
  return [...endpoints].sort();
}

function sourceFiles(): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && path !== __dirname) {
          visit(path);
        }
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")) {
        files.push(path);
      }
    }
  };
  SOURCE_DIRECTORIES.forEach((directory) => visit(join(REPOSITORY, directory)));
  return files.sort((a, b) => relative(REPOSITORY, a).localeCompare(relative(REPOSITORY, b)));
}

/**
 * Returns the argument of a call that starts at the given position of the source.
 */
function argumentAt(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const character = source[i];
    if (quote != null) {
      if (character === "\\") {
        i++;
      } else if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if ("([{".includes(character)) {
      depth++;
    } else if (")]}".includes(character)) {
      if (depth === 0) {
        return source.substring(start, i);
      }
      depth--;
    } else if (character === "," && depth === 0) {
      return source.substring(start, i);
    }
  }
  return source.substring(start);
}

/**
 * Returns what a path that is passed as a variable was last given as its value before the call.
 */
function resolveVariable(source: string, callIndex: number, expression: string): string {
  const name = expression.trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    return expression;
  }
  const assignments = [
    ...source
      .substring(0, callIndex)
      .matchAll(new RegExp(`(?:const|let)\\s+${name}\\s*(?::\\s*string\\s*)?=\\s*`, "g")),
  ];
  const last = assignments[assignments.length - 1];
  if (last == null) {
    return expression;
  }
  const start = last.index + last[0].length;
  const end = source.indexOf(";", start);
  return source.substring(start, end === -1 ? undefined : end);
}

/**
 * Turns the expression that a path is built with into the path, with `{}` for each part that
 * is not written out. A query is left out.
 */
function toPath(expression: string): string {
  let path = "";
  for (const part of expression.matchAll(/"([^"]*)"|`([^`]*)`|[A-Za-z_][\w.]*(?:\([^()]*\))?/g)) {
    const literal = part[1] ?? part[2];
    path += literal == null ? "{}" : literal.replace(/\$\{[^}]*\}/g, "{}");
  }
  return path.split("?")[0].replace(/(\{\})+/g, "{}");
}

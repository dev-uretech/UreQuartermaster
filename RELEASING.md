# Releasing UreQuartermaster

Manual copies of the skill install an update only when the release archive carries a valid Ed25519 signature
made with the project's private key. This file is the procedure for maintainers. (Plugin and skills CLI installs
update through their manager and do not check this signature.)

## 1. Create the signing key: mandatory before the first release

Do this **before the first release**. A release whose `pubkey.mjs` holds no key could never update itself, and
`release.mjs` refuses to build one.

1. Create an empty folder **outside the repository**, on storage you will keep offline.
2. Run:

   ```bash
   node scripts/keygen.mjs <that folder>
   ```

   It writes `urequartermaster-signing.key` there (mode 0600 where the system supports it, never overwritten) and
   prints only the **public** key. It refuses a folder inside the repository.
3. Paste the printed public key into `skills/urequartermaster/scripts/lib/pubkey.mjs` as `PUBLIC_KEY_PEM` and
   commit it. `release.mjs` refuses to build when this is `null` or does not match the key you sign with.

## 2. Keep the private key offline

- Never commit it, never paste it into a chat, an issue, a CI secret or a log, never send it by email.
  `*.key` is in `.gitignore` as a last line of defense, not as permission to keep it nearby.
- Keep it on storage that is offline when you are not signing (an encrypted USB drive, a hardware-backed vault),
  and keep at least one more offline backup in a different place.
- Whoever holds this file can ship code to every manual installation. If it may have leaked, see section 5.

## 3. Prepare the release

1. Bump `VERSION` in `skills/urequartermaster/scripts/lib/version.mjs` (the single source of the version), and the
   same number in `package.json`, `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
   (`npm test` checks that they agree).
2. Add a `## X.Y.Z` section to `CHANGELOG.md` with what changed. Its text becomes the release notes.
3. Run `npm test` and commit. `release.mjs` requires **no uncommitted or untracked changes under
   `skills/urequartermaster`**: what gets signed must be what is committed.
4. **Push the release commit** (`git push`) before creating the release: `gh release create` tags the head of the
   default branch on GitHub.

## 4. Build, sign and publish

```bash
node scripts/release.mjs --key <path to urequartermaster-signing.key> --version X.Y.Z
```

The script checks that `version.mjs` and `CHANGELOG.md` agree with `X.Y.Z` and that `pubkey.mjs` holds the public
key of `--key`. It then builds the bundle from `skills/urequartermaster`, signs it, verifies the signature, writes
`dist/` (bundle, `.sig`, `SHA256SUMS`) and **prints** the publish command without running it:

```bash
gh release create vX.Y.Z dist/<bundle> dist/<bundle>.sig dist/SHA256SUMS --title vX.Y.Z --notes-file <notes>
```

Run the printed command, then disconnect the key storage.

Then check that an update really arrives. On a machine with an older **manual** copy, run `qm update --check` and
`qm update`, and check that `qm --version` prints `X.Y.Z`. Plugin and skills CLI installs update through their
manager (`claude plugin update urequartermaster@urequartermaster`, `npx skills update urequartermaster`).

## 5. Rotate the key

The code trusts exactly one public key, so the new key must reach installations inside a release they already
trust: **a release, signed with the old key, whose `pubkey.mjs` contains the new key.**

1. Create the new key pair with `node scripts/keygen.mjs <another offline folder>`.
2. Put the **new** public key in `pubkey.mjs`, bump the version, add a CHANGELOG entry that mentions the
   rotation, commit and push.
3. Build with the **new** key, since `release.mjs` only accepts the key that matches `pubkey.mjs`:
   `node scripts/release.mjs --key <new key> --version X.Y.Z`
4. Re-sign the same bundle with the **old** key. This replaces `dist/<bundle>.sig` and `dist/SHA256SUMS` and
   prints nothing secret; it works on Windows, macOS and Linux:
   `node scripts/resign.mjs --key <old key> --version X.Y.Z`
5. Publish with the `gh release create` command printed in step 3. Installations verify with the key they already
   have (the old one), install the release, and from then on trust only the new key.
6. Keep the old key offline until every supported installation has moved past the rotation release, then destroy
   it.

Copies that stay offline across a rotation must be reinstalled. `qm` only ever fetches `releases/latest`: once a
release signed with the new key is the latest, a copy that never installed the rotation release still trusts only
the old key and rejects it.

If the old key is compromised, this path is not safe: publish a notice asking users to reinstall from a trusted
source, which ships the new key.

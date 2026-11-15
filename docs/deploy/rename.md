# Moving a deployed xin Worker to ingle

The Worker script is named `ingle` now. Durable Object data belongs to the script that defines the class, so a plain `wrangler deploy` of `ingle` creates a second, empty `Home` and leaves the owner's data under the old `xin` script. An existing install moves its data with one transfer deploy. A fresh install skips this page.

1. Give the new script the same secrets as the old one, before it serves anything. `KEK` must be identical or the sealed credentials cannot be opened:

   ```bash
   bunx wrangler secret put OWNER_TOKEN -c wrangler.transfer.jsonc
   bunx wrangler secret put KEK -c wrangler.transfer.jsonc
   ```

2. Deploy once with the transfer config. Its only migration is `transferred_classes: Home from xin`, so Cloudflare moves the `Home` namespace and every object's SQLite into `ingle` in one step, and the old script's `HOME` binding forwards to it:

   ```bash
   bun --cwd web run build
   bunx wrangler deploy -c wrangler.transfer.jsonc --assets ./web/dist
   ```

3. Check `https://ingle.<account>.workers.dev/v1/status` with the owner token, and that existing projects and conversations are listed.

4. From then on, deploy with `wrangler.free.jsonc` (or `wrangler.jsonc` on the paid plan) as before. The new script already carries migration tag `v1`, so the `new_sqlite_classes` step is skipped and the transferred namespace is kept.

5. When the new origin is verified, delete the old script with `bunx wrangler delete --name xin`, and delete `wrangler.transfer.jsonc` from the repository.

The R2 bucket keeps the name `xin-files`, because a bucket cannot be renamed and its blobs are what the `files` table points to. Stored identifiers keep the `xin.` prefix too: document kinds (`xin.intake`, `xin.workspace`, ...), entry kinds (`xin.batch`, `xin.error`), task and extension names, and the browser's `xin.token` key. They are data inside the journal and in browsers, not names of the product.

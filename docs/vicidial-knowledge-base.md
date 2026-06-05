# VICIdial Knowledge Base (for Genisys Hub integrations)

> **Audience.** Genisys Hub engineers planning integrations against the BPO's VICIdial install at `expeditusbpo.vicitel.cc`. Assume VICIdial 2.14, default schema, HTTP Basic + `VD_login`/`VD_pass` cookie auth wrapping admin.php, and Render outbound IPs whitelisted.
>
> **What the Hub already has.**
> - `lib/recording-proxy.ts` — signed HMAC URLs that proxy the BPO's `/RECORDINGS/MP3/*.mp3` so we never expose the BPO's raw URL.
> - `/team/live-report` — server-side scrape of `vicidial/admin.php`'s home dashboard, mirrored into the Hub.
> - **Team #1 members** admin surface — Mary's offshore agents register with name + state + password (no email); Alex manually assigns a free-form "call center number" string that is **not yet** linked to a VICIdial `user_id` (the `850001`–`850029` range visible on the Users panel).
>
> When this doc says **"Not documented; suggest direct testing on the install,"** that means the upstream sources don't authoritatively cover it and we should poke the live BPO box to confirm before wiring code to it.

---

## 1. Architecture overview

VICIdial is a thin web/Perl shell wrapped around an Asterisk PBX, with MySQL/MariaDB as the single source of truth for almost everything stateful. Three runtime layers cooperate, and most weird VICIdial behavior is a result of one layer falling out of sync with another.

**Layer A — Asterisk PBX.** Handles actual SIP/RTP. VICIdial drives Asterisk almost exclusively via the **Asterisk Manager Interface (AMI)** over TCP. The auto-dialer issues `Originate` actions for each lead pulled from the hopper and tracks call lifecycle by subscribing to `Newchannel`, `Bridge`, and `Hangup` events. Live agent calls are bridged into **MeetMe** conference rooms — the agent silently sits in a room, the dialer originates a call into that room when a human answers. This is why "the agent's MeetMe room" shows up everywhere in the schema (`conf_exten`, `extension`, channel naming).

**Layer B — MySQL/MariaDB (`asterisk` database).** Holds users, leads, campaigns, lists, every call log row, agent state, and recording metadata. A handful of tables are deliberately small and high-churn (`vicidial_live_agents`, `vicidial_auto_calls`, `vicidial_hopper`) — they used to be MEMORY/HEAP engine tables in older builds.

**Layer C — astguiclient daemons.** A pile of Perl scripts under `/usr/share/astguiclient/`, kept alive by `ADMIN_keepalive_ALL.pl` (driven by the `VARactive_keepalives` value in `/etc/astguiclient.conf`). Each daemon is a numbered worker:

| Code | Daemon | Plain-English job |
|------|--------|-------------------|
| 1 | `AST_update.pl` | Heartbeat. Reads AMI status, writes server stats, performance counters, keeps `servers` table fresh. The "is the dialer alive?" pulse. |
| 2 | `AST_send_listen.pl` | Manages live monitoring/barge/whisper — bridges supervisors into agent channels. |
| 3 | `AST_VDauto_dial.pl` | **The predictive dialer itself.** Pulls leads from `vicidial_hopper`, fires `Originate` over AMI, walks `vicidial_auto_calls` to validate live channels, and inserts log rows (including CANCEL/dead-call cleanup). |
| 4 | `AST_VDremote_agents.pl` | Calls remote agents on external phone numbers and keeps them parked, so the dialer can deliver calls to them like local agents. |
| 5 | `AST_VDadapt.pl` | Adaptive dialing brain. Recomputes `auto_dial_level` once per minute based on drop-rate + agent availability. **Multi-server installs must run this on exactly one node.** |
| 6 | `FastAGI_log` | AGI server that logs from dialplan into MySQL. |
| 7 | `AST_VDauto_dial_FILL.pl` | Multi-server only — fills idle agent slack from a single coordinator node. |
| 8 | `ip_relay` | TCP relay used by blind monitoring (lets a supervisor at home tap a call). |
| 9 | Timeclock auto-logout | Force-logs-out agents who left themselves logged in. |

Other notable scripts: **`AST_VDhopper.pl`** (runs every minute, refills `vicidial_hopper` for each campaign per dial-method rules), **`AST_VDadFIFO.pl`** (drains a FIFO of agent screen events queued by the dialer), **`AST_manager_kill_hung_congested.pl`** (sweeps stuck `CONGEST` and `Local/` channels Asterisk forgot to clean up).

Stack: **Asterisk 1.4–18**, **MySQL 4.1+ / MariaDB 10.x**, **Perl + DBI**, **PHP** (admin.php, agc/* agent UI, all the API endpoints), **Apache 2.x** with `mod_php`. Recordings are written by Asterisk's `Monitor()` app to `/var/spool/asterisk/monitorDONE/` and later converted/moved to `/var/spool/asterisk/RECORDINGS/{MP3,WAV,GSM,ORIG}/`.

---

## 2. Admin panel sections (`/vicidial/admin.php`)

Every section below is gated by two things working together: the user's **`user_level`** (1–9 numeric) and per-feature flags on the user record (`modify_leads`, `modify_campaigns`, `admin_hide_*`, `manage_users_active`, etc.). User levels are not strict hierarchies — a level 8 user can do almost everything a level 9 can, except a few "alter anything" screens and the admin-log viewer. Plain-English roles:

- **1** — Basic agent (fronter).
- **2–5** — Agents with mild closer/transfer privileges.
- **6** — Agent + minimal lookup rights.
- **7** — Report viewing only (good role for read-only integrations).
- **8** — Limited manager. Can modify campaigns/users/lists, but locked out of some system screens.
- **9** — "Alter anything" manager. Admin log viewer is gated here.

> Source: vicidial.org forum and community wikis — VICIdial's own docs frame these as conventions, not contracts.

### Reports
Lives at `/vicidial/admin.php?ADD=2`. Two flavors. **Real-time** (`AST_timeonVICIDIAL.php`, `AST_VDADactiveVDads.php`, the `realtime_report` screens) renders the current hopper, agents-in-call, dial-level, and per-campaign drop-rate by polling MySQL every few seconds — this is the data the Hub mirrors at `/team/live-report`. **Historical** (agent-stats, lead-disposition, campaign-stats, call-time, IVR-stats, etc.) does `GROUP BY` queries against `vicidial_log`, `vicidial_closer_log`, and `vicidial_agent_log`. Most reports accept a `stage=csv` flag and dump CSV; some return HTML tables with totals in a footer `<td>` — that's the row the Hub's lenient parser anchors on.

### Users
The top-level Users List (admin home) shows every active user with `user_id`, full name, `user_level`, group, and links to stats/edit. The `850001`–`850029` IDs Genisys sees are a BPO convention — VICIdial allows any 3-to-20-character user_id but BPOs typically pick a numeric block per client so call attribution stays unambiguous in `vicidial_log.user`. The Add User form maps directly to fields in `vicidial_users` (see schema below). The same screen sets **`api_user`** (whether this user can call non_agent_api) and **`api_allowed_functions`** (CSV allowlist).

### Campaigns
Outbound campaigns are configured here. A campaign is "the primary organizing unit for outbound calling" — it owns the dial method, dispositions, allowed lists, recording settings, AMD settings, and disposition/screen URLs.

| Dial method | Behavior |
|-------------|----------|
| `MANUAL` | `auto_dial_level` is locked at 0; agents dial each lead by clicking. |
| `RATIO` | Fixed multiplier. `auto_dial_level=3.0` means dial 3 lines per agent in READY/INCALL. |
| `ADAPT_HARD_LIMIT` | Adaptive; never exceeds the drop-rate threshold even momentarily. Most conservative — typical TCPA-safe choice. |
| `ADAPT_AVERAGE` | Targets the threshold as an average; may briefly exceed. |
| `ADAPT_TAPERED` | Allows over-drop early in the shift, tightens as shift progresses (uses `call_time`). |
| `INBOUND_MAN` | Inbound-only with manual outbound. |

`AST_VDadapt.pl` adjusts the level by at most 0.1 per minute and refuses to raise it while the drop percentage is over the campaign's limit.

### Lists
A **list** (`vicidial_list.list_id`) is a bucket of leads belonging to one campaign. The List Detail screen has reset/recycle/delete, DNC scrub, list-mix configuration, status-flow rules (how `vicidial_list.status` transitions after each call attempt). One campaign can pull from many lists; a list belongs to exactly one campaign.

### Scripts
Agent-screen scripts (`vicidial_scripts`). Variable substitution uses double-bracket tokens like `--A--first_name--B--`, `--A--phone_number--B--`, and any custom field. Scripts are bound at the campaign or list level.

### Filters
Lead filtering rules — SQL `WHERE` snippets stored in `vicidial_lead_filter` that the hopper-loader applies when refilling. Time-zone rules (which leads are callable right now based on local time in the area code/postal code) are configured under Admin → Call Times rather than here, but Filters can layer on top.

### Inbound
Inbound groups (`vicidial_inbound_groups`), DIDs (`vicidial_inbound_dids`), IVR menus, and call-menu trees. An in-group has a `group_id`, hold music, queue priority, drop-call settings, and an allowed-agent list (often defined through User Groups). Inbound calls land in `vicidial_closer_log` instead of `vicidial_log`.

### User Groups
A user group (`vicidial_user_groups`) bundles permissions: allowed campaigns, allowed in-groups, allowed reports, allowed admin screens, recording-listen rights, and per-screen "modify" flags. Authorization is the union of `user.user_level` rules and `user_group` rules.

### Remote Agents
External phone numbers (cell phones, remote PBXs) the dialer can deliver calls to as if they were logged-in agents. Backed by `vicidial_remote_agents`. The `AST_VDremote_agents.pl` daemon dials them and keeps them parked.

### Admin
System Settings (`system_settings` table — one row), server config (`servers`), phones (`phones` — the SIP/IAX endpoints), call times, shifts, audio store, music-on-hold, voicemail. The **System Settings** page is where the `recording_log_redirect.php` enforcement gets toggled (the "Log Recording Access" flag).

---

## 3. Database schema highlights

Genisys integrations should read from these tables directly only over a read-only MySQL grant or the API. **Never write directly** unless we own the install — VICIdial's daemons rely on specific transition orders.

### `vicidial_list` — leads
- **PK:** `lead_id` (auto-increment int).
- Key columns: `entry_date`, `modify_date`, `status`, `user`, `vendor_lead_code`, `list_id`, `phone_code`, `phone_number`, `first_name`, `last_name`, `address1..3`, `city`, `state`, `postal_code`, `country_code`, `gender`, `date_of_birth`, `email`, `called_count`, `last_local_call_time`, `rank`, `owner`, `entry_list_id`, plus `custom_fields_*` if enabled.
- Powers: lead lookup by phone, dedup checks, the agent screen pop, list reset, recycling.

### `vicidial_log` — every outbound call attempt
- **PK:** `uniqueid` (the Asterisk uniqueid, e.g. `1685554443.12345`).
- Key columns: `lead_id`, `call_date`, `start_epoch`, `end_epoch`, `length_in_sec`, `status` (the final 6-char-max disposition), `phone_code`, `phone_number`, `user`, `comments`, `processed`, `user_group`, `term_reason`, `alt_dial`, `campaign_id`.
- Powers: every "calls today by agent X" report, every recording lookup that doesn't already know the recording_id, every retry/recycle decision.

### `vicidial_closer_log` — inbound and transferred calls
- **PK:** `closecallid`.
- Key columns: `lead_id`, `call_date`, `start_epoch`, `end_epoch`, `length_in_sec`, `status`, `phone_code`, `phone_number`, `user`, `campaign_id`, `term_reason`, `queue_seconds`, `comments`, `processed`, `user_group`, `xfercallid`, `uniqueid`.
- Same shape as `vicidial_log` but for the "closer" side — when a fronter transfers a call to a closer, the closer's leg lands here. Inbound calls bypass `vicidial_log` and write only here.

### `vicidial_agent_log` — agent state changes
- **PK:** `agent_log_id`.
- Key columns: `user`, `event_time`, `lead_id`, `campaign_id`, `pause_epoch`, `pause_sec`, `wait_epoch`, `wait_sec`, `talk_epoch`, `talk_sec`, `dispo_epoch`, `dispo_sec`, `status`, `user_group`, `comments`, `sub_status`, `dead_epoch`, `dead_sec`.
- Powers: agent occupancy reporting (wait/talk/pause/dispo/dead seconds for every session), AHT calculations, the "what was Mary doing at 14:32" forensic queries.

### `vicidial_users` — agent records
- **PK:** `user_id` (the 3–20-char string — `850001` etc.).
- Key columns: `user` (login), `pass` (PLAINTEXT — see Security), `full_name`, `user_level`, `user_group`, `phone_login`, `phone_pass`, `email`, `active`, `agent_choose_ingroups`, `closer_campaigns`, `delete_users`, `modify_users`, `modify_leads`, `modify_lists`, `modify_campaigns`, `modify_servers`, `modify_settings`, `view_reports`, `vicidial_recording_id` (last recording the user accessed), `api_user`, `api_allowed_functions`, `custom_one..five`.
- **No email is required** at the schema level — fine for Mary's offshore agents.

### `vicidial_live_agents` — real-time agent state
- **PK:** `user` + `server_ip` (composite — one row per active session).
- Key columns: `user`, `server_ip`, `conf_exten`, `extension`, `status` (`READY`, `INCALL`, `PAUSED`, `CLOSER`, `QUEUE`, `3-WAY`), `lead_id`, `campaign_id`, `uniqueid`, `callerid`, `channel`, `random_id`, `last_call_time`, `last_update_time`, `last_state_change`, `agent_log_id`, `calls_today`, `comments`.
- High-churn. This is what the realtime report polls. Empty rows mean "no live sessions."

### `vicidial_campaigns` — campaign config
- **PK:** `campaign_id` (string, e.g. `SOLAR1`, 8 chars max in older builds).
- Hundreds of columns: `dial_method`, `auto_dial_level`, `adaptive_maximum_level`, `adaptive_dropped_percentage`, `dial_statuses`, `lead_order`, `lead_filter_id`, `hopper_level`, `dial_prefix`, `campaign_cid`, `campaign_recording`, `campaign_rec_filename`, `disposition_call_url`, `start_call_url`, `web_form_address`, `xferconf_*`.
- Read this once and cache — config-table, not high-churn.

### `vicidial_lists` — list config (note: plural)
- **PK:** `list_id` (int).
- Key columns: `list_name`, `campaign_id`, `active`, `list_description`, `list_lastcalldate`, `expiration_date`, `reset_time`, `am_message_exten`, `drop_inbound_group`, `web_form_address`, `transfer_conf_number`.
- Don't confuse with `vicidial_list` (singular, the leads).

### `vicidial_recording_log` — recording metadata
- **PK:** `recording_id` (auto-increment int).
- Key columns: `channel`, `server_ip`, `extension`, `start_time`, `start_epoch`, `end_time`, `end_epoch`, `length_in_sec`, `length_in_min`, `filename` (without extension), `location` (full URL or path the admin set in System Settings), `lead_id`, `user`, `vicidial_id` (the dialer's call uniqueid that ties back to `vicidial_log.uniqueid`).
- Powers our recording-proxy. The `lead_id` + `user` + `start_epoch` triple is the most reliable join key when matching to `vicidial_log`.

> Other tables worth knowing exist: `vicidial_hopper`, `vicidial_auto_calls`, `vicidial_user_groups`, `vicidial_inbound_groups`, `vicidial_inbound_dids`, `vicidial_lead_filter`, `vicidial_dnc`, `system_settings`, `servers`, `phones`. Out of scope here.

---

## 4. APIs

VICIdial ships three integration surfaces. None of them are REST. All return plain text, pipe-delimited, or CSV — there is **no JSON by default**.

### `non_agent_api.php` — system / lead / config
Endpoint: `https://server/vicidial/non_agent_api.php`. Every request must include `source` (free-form caller ID, ≤20 chars), `user`, `pass`. The user must have `api_user=1`, and the called function must appear in `api_allowed_functions` if that allowlist is non-empty.

Documented functions:

| Function | Min user_level | Purpose |
|----------|---------------|---------|
| `version` | any | Prints `VERSION/BUILD/DATE/EPOCH/DST/TZ/TZNOW`. Healthcheck. |
| `sounds_list` | 7 | List audio store files. |
| `moh_list` | 7 | List music-on-hold classes. |
| `vm_list` | 7 | List voicemail boxes. |
| `blind_monitor` | 7 | Drop the calling user into a session as MONITOR/BARGE/HIJACK. |
| `agent_ingroup_info` | 7 | Show/change in-groups for a logged-in agent. |
| `recording_lookup` | depends | Look up recordings by `agent_user` OR (`lead_id` + `date`). 100k row cap. |
| `did_log_export` | depends | Per-day inbound DID call list. 100k row cap. |
| `add_lead` | 8 + `modify_leads=1` | Insert into `vicidial_list`. Required: `phone_number`, `phone_code`, `list_id`, `source`. ~30 optional fields including callback parameters. |
| `update_lead` | 8 + `modify_leads=1` | Update by `lead_id` OR `vendor_lead_code` OR `phone_number`. |
| `add_user` / `add_phone` / `update_phone` / `add_phone_alias` / `update_phone_alias` | 8+ | Provisioning. |
| `add_list` / `update_list` | 8+ | Provisioning + reset/delete. |

Real-time-stats functions **commonly cited in community docs** (`agent_status`, `system_status`, `agents_status`, `campaign_stats`, `agent_stats`, `lead_search`, `dnc_check`, `add_callback`, `remove_callback`, `update_campaign`, `call_agent`) exist in the source but with version-specific behavior; some newer builds added an `include_ip` option to `agent_status`. **The exact parameter contract for these stats functions on the BPO's 2.14 install is not documented; suggest direct testing on the install** before wiring the Hub to them.

Sample call:
```
https://server/vicidial/non_agent_api.php?source=genisyshub&user=apiuser&pass=apipass&function=add_lead&phone_number=5551234567&phone_code=1&list_id=10001&first_name=John&last_name=Smith
```

Sample response (success):
```
SUCCESS: add_lead LEAD HAS BEEN ADDED - 7275551111|6666|999|193715|-4
```
The trailing pipe-delimited tail is `phone|list_id|lead_id|...`.

### `agent_api.php` — drive a live agent screen
Endpoint: `https://server/agc/api.php`. Same auth (`source`, `user`, `pass`) plus `agent_user` — the agent being controlled. **The target agent must already be logged into the agent screen** for almost every action to work; this is not a way to log an agent in from the outside.

| Function | Effect |
|----------|--------|
| `version` | Healthcheck. |
| `external_hangup` | Hang up the current customer call. |
| `external_status` | Set the disposition code; closes the call. Pass `---` to query. |
| `external_pause` / `external_resume` | Pause or resume; defers if mid-call. |
| `logout` | End agent session. |
| `external_dial` | Click-to-call. Search/preview/CID options. |
| `external_add_lead` | Push a one-off lead into the agent's manual list. |
| `change_ingroups` | Modify which in-groups the agent is taking. |
| `update_fields` | Mutate the lead the agent is currently on. |
| `set_timer_action` | Fire a webform/dial/message at a scheduled offset. |
| `send_dtmf` | Inject DTMF into the agent's bridged call. |
| `park_call` / `transfer_conference` | Park / unpark / transfer / 3-way / blind transfer. |
| `ra_call_control` | Remote-agent hang up / transfer. |
| `st_login_log` / `st_get_agent_active_lead` | CRM ID ↔ VICIdial user mapping helpers. |

### Asterisk Manager Interface (AMI)
Direct TCP. VICIdial uses it internally — supervisor monitoring, conference management, and the dialer itself stream `Newchannel`, `Newexten`, `Bridge`, `Hangup`, `Hold`, `MusicOnHold` events. We **could** subscribe externally for true real-time, but the BPO is extremely unlikely to expose port 5038 across the public internet (and shouldn't). Treat AMI as off-limits unless the BPO explicitly opens it.

### Webhooks (such as they are)
VICIdial has no native push-webhook system. Two campaign-level URL fields fake it:
- **Start Call URL** — fires GET when a call connects to an agent (screen-pop trigger).
- **Dispo Call URL** — fires GET when an agent dispositions a call.

Both support `--A--field--B--` token substitution (lead_id, phone_number, user, dispo, campaign_id, custom fields). Example:
```
https://hub.genisys.example.com/api/vicidial/disposition?lead_id=--A--lead_id--B--&phone=--A--phone_number--B--&status=--A--dispo--B--&agent=--A--user--B--
```
This is the **best lightweight way to pull dispositions out** without polling — but requires BPO cooperation to set the URL on each campaign.

---

## 5. Integration-relevant features

### Recording URLs and the `vicidial_log` → mp3 mapping
Recordings are conf-room captures. Asterisk's `Monitor()` writes them to `/var/spool/asterisk/monitorDONE/` then `MOVE_RECORDING_FILES_VICIDIAL.pl` converts to MP3/GSM and updates `vicidial_recording_log.location`.

Filename pattern (varies slightly by build/config): `<campaign>_<agent>_<YYYYMMDD>-<HHMMSS>_<phone_number>-all.mp3`, e.g. `CAMP1_agent46_20190124-001018_8885539229-all.mp3`. Older configs use `<YYYYMMDD>-<HHMMSS>_<phone>_camp_<list_id>-all.mp3`. The Genisys BPO's pattern should be confirmed by reading a few rows from `vicidial_recording_log.filename` — **not documented as a global contract; suggest direct testing on the install.**

Mapping path the Hub should follow: **`vicidial_log.uniqueid` → `vicidial_recording_log.vicidial_id` → `vicidial_recording_log.location`**. If `vicidial_id` is empty (older builds left it blank for some call types), fall back to joining on (`lead_id`, `user`, `start_epoch` within ±2 s). The location column may be a full http URL or just a relative path; the Hub's HMAC-proxy should normalize either form.

### Identifying an agent across systems
VICIdial's `user_id` is a 3–20 char string. The 6-digit `850xxx` IDs on Genisys's install are a BPO convention; nothing in the schema enforces "numeric." The Hub's current free-form `call_center_number` string is the right shape to eventually store a VICIdial `user_id` — recommended next step: rename it to `vicidial_user_id`, validate against `vicidial_users.user_id`, and use that join key everywhere downstream.

### Real-time stats
Three options ordered by cost:
1. **Scrape `admin.php` realtime report** (what the Hub does today). Brittle, but works through HTTP Basic + cookie auth.
2. **`non_agent_api.php?function=system_status` / `agent_status` / `agents_status`.** Cheaper if the BPO grants an `api_user`. Contract varies by version — confirm before integrating.
3. **Read-only MySQL grant on `vicidial_live_agents`, `vicidial_auto_calls`, `vicidial_campaigns`, `vicidial_inbound_groups_call`.** Lowest latency, highest fidelity. Requires BPO cooperation and likely a SSH tunnel.

### Push a lead in
`non_agent_api.php?function=add_lead` is the supported path. Honors `duplicate_check=DUPLIST|DUPCAMP|DUPSYS`. Returns `SUCCESS: add_lead LEAD HAS BEEN ADDED - phone|list_id|lead_id|gmt|...` or `NOTICE: add_lead DUPLICATE`. Don't INSERT into `vicidial_list` directly — bypasses dedup, custom field validation, and the GMT-offset auto-fill.

### Pull dispositions out
- **Push:** the campaign Dispo Call URL (above).
- **Pull poll:** `vicidial_log` rows where `status NOT IN ('NEW','','READY')` and `modify_date >= X`. Pair with `vicidial_closer_log` for inbound/transferred outcomes.
- **API:** `non_agent_api.php?function=recording_lookup` returns dispositioned-call rows tied to a recording (limited to 100k).

---

## 6. Security considerations

**Default accounts to never expose.** Stock VICIdial installs ship with a level-9 `6666 / 1234` admin and a `VDAD / VDAD` API user. Both are well-known and routinely brute-forced. Confirm with the BPO that neither exists on the live install, and never log either credential to the Hub side.

**Plaintext `VD_pass` cookie.** VICIdial stores the admin login password **in plaintext** in the `VD_pass` cookie and in `vicidial_users.pass`. This is the entire "auth" of `admin.php`. Consequences for the Hub:
- Treat the BPO's stored `VD_login`/`VD_pass` as a top-tier secret, not a session token. Don't print it in logs, don't pass it through query strings, encrypt-at-rest, and rotate if it leaks.
- The cookie is sent on every admin.php request. Render outbound IP whitelist is what stops a leak from being a total compromise — verify the whitelist hasn't drifted before publishing the cookie value anywhere.

**HTTP Basic wrapper.** Many BPOs (including ours) front `/vicidial/admin.php` with HTTP Basic auth as a second factor. The Hub already handles that. New endpoints (`non_agent_api.php`, `agc/api.php`, `/RECORDINGS/`) often need either the same Basic header or their own allowlist — confirm per-path with the BPO before integrating.

**Read-only vs write API access.** The `api_allowed_functions` field on `vicidial_users` is a CSV allowlist. Genisys should request a dedicated API user with **only** the functions we need (`version`, `agent_status`, `system_status`, `recording_lookup` for read; `add_lead`, `update_lead` if pushing leads). Never request level-9 + empty allowlist; it's an unbounded blank check.

**Rate limiting.** VICIdial has **no built-in rate limiting**. Practical guidance from community docs: keep lead injection under ~5–10/sec, stats polling at 15-second-or-slower intervals. Faster pushes risk MySQL contention on `vicidial_list` and `vicidial_hopper`, especially during hopper-refill minutes.

**Recordings.** The `/RECORDINGS/` directory is web-served by Apache. If the BPO turns on "Log Recording Access" in System Settings, requests go through `recording_log_redirect.php` and are logged — otherwise direct `.mp3` URLs are trivially scrapable. The Hub's HMAC signing layer compensates from our side.

---

## 7. BPO operational patterns

**Agent number → physical phone mapping.** A VICIdial `user_id` is not a phone. The phone is a separate row in the `phones` table keyed by `extension` + `server_ip` (the SIP/IAX endpoint). The link is `vicidial_users.phone_login` → `phones.login`. Same agent can use different phones from different machines on different days; on shared-desk BPOs, the Hub should treat `user_id` as the durable identity and ignore `extension`.

**"Manager" vs "agent."** No hard schema distinction. By convention: `user_level <= 6` and `phone_login` set = agent; `user_level >= 7` without active phone = manager/QA. The agent screen (`agc/vicidial.php`) and admin screen (`admin.php`) are different URLs; user_level just gates what each one renders.

**Disposition status codes.** Status codes are at most 6 characters (the `vicidial_list.status` column is `varchar(6)`). VICIdial ships these system statuses:

| Code | Type | Meaning |
|------|------|---------|
| `NEW` | system | Never called. |
| `SALE` | agent | Sale made. |
| `XFER` | agent | Transferred to closer. |
| `NI` | agent | Not interested. |
| `NP` | agent | No pitch / no price. |
| `DC` | agent | Disconnected number. |
| `DNC` | agent | Do not call — also adds to DNC list. |
| `B` | agent | Busy. |
| `A` | agent | Answering machine (agent-marked). |
| `CALLBK` | system | Callback scheduled. |
| `NA` | dialer | No answer auto. |
| `AA` | dialer | Answering machine auto (AMD). |
| `AB` | dialer | Busy auto. |
| `ADC` | dialer | Disconnected auto. |
| `AFAX` | dialer | Fax detected. |
| `AM` | system | Answering machine — message left. |
| `AL` | system | Answering machine message played. |
| `PU` | system | Call picked up. |
| `DROP` | system | Agent unavailable when human answered (the FCC drop). |
| `PDROP` | system | Pre-routing drop. |

Any 1–6 char code can be added per campaign via Admin → Lists → Statuses or Campaign → Statuses. Each status has flags for `human_answered`, `sale`, `dnc`, `customer_contact`, `not_interested`, `unworkable`, `scheduled_callback`, and **`selectable`** (whether the agent can pick it). The "REMOVE from active dialing" decision is per-status per-campaign: `vicidial_campaign_statuses.selectable=Y` + the `dial_statuses` campaign field filter.

**Multi-tenant isolation on shared BPO installs.** VICIdial is **not** truly multi-tenant. Tenants are simulated via:
- Disjoint `user_group` per tenant, with per-group `allowed_campaigns` and `allowed_reports`.
- Disjoint `campaign_id` and `list_id` prefixes.
- Per-tenant inbound DIDs.

A user with `user_level=8`+ and "modify users" can see everything in the database. There is **no row-level data partitioning**. For Genisys this means: assume the BPO's QA managers can read all of Mary's recordings even when we don't want them to, and architect the Hub side accordingly (e.g., signed recording URLs scoped to client view, not raw paths).

**Recording attribution.** Recording ownership flows `vicidial_recording_log.user` → `vicidial_users.user_id` → user_group → (BPO mapping) → Hub client. If Genisys's "call center number" string becomes a true `vicidial_user_id`, recording-to-client routing simplifies to a single join.

---

## Sources

- vicidial.org official docs: [NON-AGENT_API.txt](https://vicidial.org/docs/NON-AGENT_API.txt), [AGENT_API.txt](https://vicidial.org/docs/AGENT_API.txt), [VICIDIAL_statuses.txt](https://vicidial.org/docs/VICIDIAL_statuses.txt)
- GitHub mirror (inktel/Vicidial): [NON-AGENT_API.txt](https://github.com/inktel/Vicidial/blob/master/docs/NON-AGENT_API.txt), [AGENT_API.txt](https://github.com/inktel/Vicidial/blob/master/docs/AGENT_API.txt), [VICIDIAL_statuses.txt](https://github.com/inktel/Vicidial/blob/master/docs/VICIDIAL_statuses.txt), [PREDICTIVE.txt](https://github.com/inktel/Vicidial/blob/master/docs/PREDICTIVE.txt), [non_agent_api.php source](https://github.com/inktel/Vicidial/blob/master/www/vicidial/non_agent_api.php), [recording_lookup.php source](https://github.com/inktel/Vicidial/blob/master/www/vicidial/recording_lookup.php), [ADMIN_keepalive_ALL.pl](https://github.com/inktel/Vicidial/blob/master/bin/ADMIN_keepalive_ALL.pl), [AST_VDauto_dial.pl](https://github.com/inktel/Vicidial/blob/master/bin/AST_VDauto_dial.pl), [README.txt](https://github.com/inktel/Vicidial/blob/master/README.txt)
- ViciWiki: [Vicidial_Database_Structure](https://viciwiki.com/index.php/Vicidial_Database_Structure), [Vicidial_Admin.php_Change_List](https://viciwiki.com/index.php/Vicidial_Admin.php_Change_List), [Vicidial_RatioManager](https://viciwiki.com/index.php/Vicidial_RatioManager)
- ViciStack blog: [API Integration Guide](https://vicistack.com/blog/vicidial-api-integration/), [Campaign glossary](https://vicistack.com/glossary/campaign/), [User Group glossary](https://vicistack.com/glossary/user-group/), [Auto-Dial Level Tuning](https://vicistack.com/blog/vicidial-auto-dial-level-tuning/), [Asterisk AMI Guide](https://vicistack.com/blog/asterisk-manager-interface-guide/), [VICIdial Training Guide](https://vicistack.com/blog/vicidial-training-guide/)
- vicidial.org forums (operational lore): [AST_VDauto_dial issues](https://vicidial.org/VICIDIALforum/viewtopic.php?t=5264), [Database know-how](https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=41838), [Final Disposition discussion](https://www.vicidial.org/VICIDIALforum/viewtopic.php?f=2&t=38162), [User Level discussion](http://www.eflo.net/VICIDIALforum/viewtopic.php?t=7861)
- Other: [Securing the recordings folder (Striker24x7)](https://www.striker24x7.com/2021/08/securing-vicidial-recordings-folder.html), [astguiclient.conf sample (goautodial v4.0)](https://github.com/goautodial/v4.0/blob/master/astguiclient.conf-sample), [VICIdial Status Codes (blissweb)](http://theblissweb.com/2017/02/06/vicidial-status-codes/)

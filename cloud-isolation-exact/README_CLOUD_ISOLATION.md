# Factory cloud isolation payload

This branch is a temporary transport for two immutable Git-tree exports.

## Trees

- `caps-acdd9f6/`
  - source commit: `acdd9f653233a2586ec6b97546c18568ba7b7f4b`
  - source tree: `fb0c3ad38b7ec854c621aafd193812d6c153a77b`
  - archive SHA-256: `9020672B3BD61BE4B976B59CD20DBD87CE5B3EBA08073D566F4AD4A60C21B333`
- `bridge-dccb98f/`
  - source commit: `dccb98f99b41049a9707f2b479b3975f977b61b5`
  - source tree: `1014be76178c89c221bd8777f8d55093817cbdb5`
  - archive SHA-256: `BD9155305B7C39EBCF50F8B6601866AD8D12E2C780C82D3F029CD728E1EC4EB3`

Both directories were generated with `git archive`. They contain tracked source
only: no `.git`, `node_modules`, live databases, browser state, credentials, or
local untracked files.

Do not modify these trees during isolation testing.

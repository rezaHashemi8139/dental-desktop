# protovalidate (vendored)

`buf/validate/validate.proto` from [buf.build/bufbuild/protovalidate](https://buf.build/bufbuild/protovalidate),
Apache-2.0 (see LICENSE). The server's protos import it for their validation rules; `build.rs` only needs
it to resolve that import (the rules themselves are checked by the server).

Pinned to the commit in `dental-server/buf.lock`: `511051f7f4374c3ca873b53ae68a9288`.
To update after that changes: `buf dep update` in dental-server, then copy the file from
`%LOCALAPPDATA%\buf\v3\modules\b5\buf.build\bufbuild\protovalidate\<commit>\files\buf\validate\`.

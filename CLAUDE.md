# Graft

## Graft provenance

This repository is reviewed by Graft. Every commit you create must end with these trailers, in the
last paragraph of the message (use `git commit --trailer`, or write them on their own lines next to
any `Co-Authored-By` line):

    Graft-Agent: claude-code
    Graft-Model: <the model id you are running as, for example claude-opus-5-5>
    Graft-Task: <an issue reference such as #42, only when the task has one>

When you open a pull request, end its description with the same lines as its last paragraph, after
any other footer. Graft reads them there when a commit has none.

Never invent a `Graft-Session` value: add it only when you have a real `https` link to the session.

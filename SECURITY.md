# Security policy

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/thepolytheist/agent-ready/security/advisories/new),
not in a public issue. You should hear back within a week.

agent-ready reads repository files and, for `owner/repo` targets, sends one GraphQL request to
api.github.com with the token you provide. It never runs code from the repository it grades.
Reports about a crafted repository that makes the grader execute code, leak the token, or hang
are especially welcome.

Only the latest release gets fixes.

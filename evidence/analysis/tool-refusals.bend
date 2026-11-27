import Base

def refusal_label(result: String & String & U32) -> String:
  match result:
    case ("failed", "foreground-shell-wrapper", 4294967295): "t3-terminal-backgrounding-refused"
    case ("failed", "foreground-ampersand", 4294967295): "t3-terminal-backgrounding-refused"
    case ("failed", "github-view-comment-format", 1): "github-view-comment-format-conflict"
    case ("failed", "git-fork-resource-unavailable", 255): "git-child-process-spawn-refused"
    case ("completed", "shell-fork-retry", 0): "local-shell-fork-retry-observed"
    case ("failed", "ssh-authentication-denied", 255): "ssh-authentication-refused"
    case ("failed", "nomac-queue-busy", 2): "native-mac-queue-lock-busy"
    case ("failed", "nomac-queue-busy", 75): "native-mac-queue-lock-busy"
    case ("failed", "nomac-insufficient-credit", 2): "native-mac-credit-refused"
    case ("failed", "github-project-read-scope", 1): "github-project-read-scope-refused"
    case ("failed", "gitlab-unknown-option", 1): "gitlab-cli-option-refused"
    case ("completed", "gitlab-pipeline-age-refused", 0): "gitlab-pipeline-age-cutoff-observed"
    case ("failed", "tool-t3-unknown-name", 4294967295): "t3-tool-name-unresolved"
    case ("failed", "tool-t3-delegate-response-invalid", 4294967295): "t3-delegation-response-invalid"
    case ("failed", "tool-t3-send-response-invalid", 4294967295): "t3-thread-send-response-invalid"
    case ("failed", "tool-t3-direct-invocation-required", 4294967295): "t3-tool-invocation-route-refused"
    case _: ""

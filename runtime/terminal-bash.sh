# Installed only in this interactive session; never writes shell rc files.
if [ -n "${BASH_VERSION-}" ]; then
  __shellpilot_seed=1
  __shellpilot_history() {
    local __shellpilot_exit=$? count=1
    if [ "$__shellpilot_seed" = 1 ]; then count=200; __shellpilot_seed=0; fi
    printf '\033]777;ShellPilot;__TOKEN__;H;%s\007' "$(HISTTIMEFORMAT= builtin history "$count" | base64 | tr -d '\r\n')"
    return "$__shellpilot_exit"
  }
  if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
    PROMPT_COMMAND+=(__shellpilot_history)
  else
    PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }__shellpilot_history"
  fi
  PS1='\[\e]777;ShellPilot;__TOKEN__;P\a\]'"$PS1"'\[\e]777;ShellPilot;__TOKEN__;I\a\]'
  PS2='\[\e]777;ShellPilot;__TOKEN__;C\a\]'"${PS2-}"
  PS0='\e]777;ShellPilot;__TOKEN__;C\a'"${PS0-}"
  if [[ $(builtin fc -ln -1 2>/dev/null) == *'__shellpilot_'* ]]; then builtin history -d -1 2>/dev/null; fi
fi
printf '\033]777;ShellPilot;__TOKEN__;Ready\007'

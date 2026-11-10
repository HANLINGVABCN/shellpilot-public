if [ -n "${ZSH_VERSION-}" ]; then
  __shellpilot_seed=1
  __shellpilot_history() {
    local __shellpilot_exit=$? count=1
    if [ "$__shellpilot_seed" = 1 ]; then count=200; __shellpilot_seed=0; fi
    printf '\033]777;ShellPilot;__TOKEN__;H;%s\007' "$(builtin fc -l -$count 2>/dev/null | base64 | tr -d '\r\n')"
    return "$__shellpilot_exit"
  }
  __shellpilot_preexec() { printf '\033]777;ShellPilot;__TOKEN__;C\007'; }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __shellpilot_history
  add-zsh-hook preexec __shellpilot_preexec
  PS1=$'%{\e]777;ShellPilot;__TOKEN__;P\a%}'"$PS1"$'%{\e]777;ShellPilot;__TOKEN__;I\a%}'
  PS2=$'%{\e]777;ShellPilot;__TOKEN__;C\a%}'"${PS2-}"
fi
printf '\033]777;ShellPilot;__TOKEN__;Ready\007'

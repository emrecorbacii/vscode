# ---------------------------------------------------------------------------------------------
#   Copyright (c) Microsoft Corporation. All rights reserved.
#   Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------
builtin autoload -Uz add-zsh-hook

# Prevent the script recursing when setting up
if [ -n "$VSCODE_SHELL_INTEGRATION" ]; then
	ZDOTDIR=$USER_ZDOTDIR
	builtin return
fi

# This variable allows the shell to both detect that VS Code's shell integration is enabled as well
# as disable it by unsetting the variable.
VSCODE_SHELL_INTEGRATION=1

# By default, zsh will set the $HISTFILE to the $ZDOTDIR location automatically. In the case of the
# shell integration being injected, this means that the terminal will use a different history file
# to other terminals. To fix this issue, set $HISTFILE back to the default location before ~/.zshrc
# is called as that may depend upon the value.
if [[  "$VSCODE_INJECTION" == "1" ]]; then
	HISTFILE=$USER_ZDOTDIR/.zsh_history
fi

# Only fix up ZDOTDIR if shell integration was injected (not manually installed) and has not been called yet
if [[ "$VSCODE_INJECTION" == "1" ]]; then
	if [[ $options[norcs] = off  && -f $USER_ZDOTDIR/.zshrc ]]; then
		VSCODE_ZDOTDIR=$ZDOTDIR
		ZDOTDIR=$USER_ZDOTDIR
		# A user's custom HISTFILE location might be set when their .zshrc file is sourced below
		. $USER_ZDOTDIR/.zshrc
	fi
fi

# Apply EnvironmentVariableCollections if needed
if [ -n "${VSCODE_ENV_REPLACE:-}" ]; then
	IFS=':' read -rA ADDR <<< "$VSCODE_ENV_REPLACE"
	for ITEM in "${ADDR[@]}"; do
		VARNAME="$(echo ${ITEM%%=*})"
		export $VARNAME="$(echo -e ${ITEM#*=})"
	done
	unset VSCODE_ENV_REPLACE
fi
if [ -n "${VSCODE_ENV_PREPEND:-}" ]; then
	IFS=':' read -rA ADDR <<< "$VSCODE_ENV_PREPEND"
	for ITEM in "${ADDR[@]}"; do
		VARNAME="$(echo ${ITEM%%=*})"
		export $VARNAME="$(echo -e ${ITEM#*=})${(P)VARNAME}"
	done
	unset VSCODE_ENV_PREPEND
fi
if [ -n "${VSCODE_ENV_APPEND:-}" ]; then
	IFS=':' read -rA ADDR <<< "$VSCODE_ENV_APPEND"
	for ITEM in "${ADDR[@]}"; do
		VARNAME="$(echo ${ITEM%%=*})"
		export $VARNAME="${(P)VARNAME}$(echo -e ${ITEM#*=})"
	done
	unset VSCODE_ENV_APPEND
fi

# Shell integration was disabled by the shell, exit without warning assuming either the shell has
# explicitly disabled shell integration as it's incompatible or it implements the protocol.
if [ -z "$VSCODE_SHELL_INTEGRATION" ]; then
	builtin return
fi

# The property (P) and command (E) codes embed values which require escaping.
# Backslashes are doubled. Non-alphanumeric characters are converted to escaped hex.
__vsc_escape_value() {
	builtin emulate -L zsh

	# Process text byte by byte, not by codepoint.
	builtin local LC_ALL=C str="$1" i byte token out=''

	for (( i = 0; i < ${#str}; ++i )); do
		byte="${str:$i:1}"

		# Escape backslashes, semi-colons and newlines
		if [ "$byte" = "\\" ]; then
			token="\\\\"
		elif [ "$byte" = ";" ]; then
			token="\\x3b"
		elif [ "$byte" = $'\n' ]; then
			token="\x0a"
		elif [ "$byte" = "%" ] && [ "${str:$((i+1)):1}" = "{" ]; then
			token="\\x25\\x7b"
			# token="\\x25\\x7b\"}"
			((i++))  # Case %{ Not sure if it is right thing to insert " and } at the end..
		elif [ "$byte" = "%" ] && [ "${str:$((i+1)):1}" = "}" ]; then
			token="\\x25\\x7d"
			((i++))  # Case %}
		else
			token="$byte"
		fi

		out+="$token"
	done

	builtin print -r "$out"
}

__vsc_in_command_execution="1"
__vsc_current_command=""

# It's fine this is in the global scope as it getting at it requires access to the shell environment
__vsc_nonce="$VSCODE_NONCE"
unset VSCODE_NONCE

__vsc_prompt_start() {
	builtin printf '\e]633;A\a'
}

__vsc_prompt_end() {
	builtin printf '\e]633;B\a'
}

__vsc_update_cwd() {
	builtin printf '\e]633;P;Cwd=%s\a' "$(__vsc_escape_value "${PWD}")"
}


__vsc_update_env() {
	builtin local env_json="{"
	builtin local first=1
	for var in ${(k)parameters}; do
		# Check if the variable is in the environment using 'printenv'
		if printenv "$var" >/dev/null 2>&1; then # only exported env vars are included
			# Add comma if not the first item
			if [ $first -eq 1 ]; then
				first=0
			else
				env_json+=","
			fi
			# Retrieve the value without executing it, and escape it for JSON
			env_json+="\"$var\":\""
			env_json+="${(P)var//\"/\\\"}"
			env_json+="\""
		fi
	done
	env_json+="}"
	# Investigation: I think } is somehow getting wrongly escaped for trailing PS1
	# In zsh %{ marks the start of non-printing characters
	# %} marks end of non-printing characters
	builtin printf '\e]633;Env;%s;%s\a' "$(__vsc_escape_value "${env_json}")" $__vsc_nonce # changing this to EnvSingle doesnt JSON.parse crash
}

__vsc_command_output_start() {
	builtin printf '\e]633;E;%s;%s\a' "$(__vsc_escape_value "${__vsc_current_command}")" $__vsc_nonce
	builtin printf '\e]633;C\a'
}

__vsc_continuation_start() {
	builtin printf '\e]633;F\a'
}

__vsc_continuation_end() {
	builtin printf '\e]633;G\a'
}

__vsc_right_prompt_start() {
	builtin printf '\e]633;H\a'
}

__vsc_right_prompt_end() {
	builtin printf '\e]633;I\a'
}

__vsc_command_complete() {
	if [[ "$__vsc_current_command" == "" ]]; then
		builtin printf '\e]633;D\a'
	else
		builtin printf '\e]633;D;%s\a' "$__vsc_status"
	fi
	__vsc_update_cwd
	__vsc_update_env
}
if [[ -o NOUNSET ]]; then
	if [ -z "${RPROMPT-}" ]; then
		RPROMPT=""
	fi
fi
__vsc_update_prompt() {
	__vsc_prior_prompt="$PS1"
	__vsc_prior_prompt2="$PS2"
	__vsc_in_command_execution=""
	PS1="%{$(__vsc_prompt_start)%}$PS1%{$(__vsc_prompt_end)%}"
	PS2="%{$(__vsc_continuation_start)%}$PS2%{$(__vsc_continuation_end)%}"
	if [ -n "$RPROMPT" ]; then
		__vsc_prior_rprompt="$RPROMPT"
		RPROMPT="%{$(__vsc_right_prompt_start)%}$RPROMPT%{$(__vsc_right_prompt_end)%}"
	fi
}

__vsc_precmd() {
	builtin local __vsc_status="$?"
	if [ -z "${__vsc_in_command_execution-}" ]; then
		# not in command execution
		__vsc_command_output_start
	fi

	__vsc_command_complete "$__vsc_status"
	__vsc_current_command=""

	# in command execution
	if [ -n "$__vsc_in_command_execution" ]; then
		# non null
		__vsc_update_prompt
	fi

	__vsc_update_env
}

__vsc_preexec() {
	PS1="$__vsc_prior_prompt"
	PS2="$__vsc_prior_prompt2"
	if [ -n "$RPROMPT" ]; then
		RPROMPT="$__vsc_prior_rprompt"
	fi
	__vsc_in_command_execution="1"
	__vsc_current_command=$1
	__vsc_command_output_start
}
add-zsh-hook precmd __vsc_precmd
add-zsh-hook preexec __vsc_preexec

if [[ $options[login] = off && $USER_ZDOTDIR != $VSCODE_ZDOTDIR ]]; then
	ZDOTDIR=$USER_ZDOTDIR
fi

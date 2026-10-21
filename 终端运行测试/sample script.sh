#!/usr/bin/env bash
printf 'script_type=bash\n'
printf 'script_path=%s\n' "$0"
printf 'working_directory=%s\n' "$PWD"
printf 'status=ok\n'

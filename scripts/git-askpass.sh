#!/bin/sh

case "$1" in
  *Username*)
    printf '%s\n' "${WARDBY_GIT_USERNAME:-x-access-token}"
    ;;
  *)
    IFS= read -r token <&3
    printf '%s\n' "$token"
    ;;
esac

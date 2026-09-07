#!/bin/sh

case "$1" in
  *Username*)
    printf '%s\n' 'x-access-token'
    ;;
  *)
    IFS= read -r token <&3
    printf '%s\n' "$token"
    ;;
esac

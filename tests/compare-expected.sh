#!/bin/bash
cd "$1"
diff <( node ../../dist/mobius.js --replay test ) expected.txt

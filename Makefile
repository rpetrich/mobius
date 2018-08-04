.PHONY: all run clean cleaner host fallback preact lint test output-test unit-test

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))
scripts=$(call rwildcard, $1/, *.tsx) $(call rwildcard, $1/, *.ts)
declarations=$(call rwildcard, $1/, *.d.ts)

all: host fallback preact

run: all
	node --trace-warnings --inspect dist/mobius.js --base ../mobius-sample --source-map --workers 2

clean:
	rm -rf dist/ docs/ mobius-*.tgz

cleaner: clean
	rm -rf node_modules

lint:
	node_modules/.bin/tslint -c tslint.json 'host/**/*.ts' 'common/**/*.ts' 'server/**/*.ts' 'client/**/*.ts' mobius.ts --fix

output-test: all
	tests/compare-expected.sh tests/randomness

unit-test: all dist/host/__snapshots__
	jest

test: lint output-test unit-test

preact: dist/common/preact.js dist/common/preact.d.ts

dist/common/:
	mkdir -p $@

node_modules/preact/dist/preact.esm.js: $(call rwildcard, node_modules/preact/src/, *.js)
	# Global tools that preact requires be available
	npm install -g npm-run-all rollup babel-cli jscodeshift gzip-size-cli rimraf
	cd node_modules/preact && npm version --allow-same-version 0.0.1 && npm install && npm run-script transpile

dist/common/preact.js: node_modules/preact/dist/preact.esm.js dist/common/
	cp $< $@

dist/common/preact.d.ts: node_modules/preact/src/preact.d.ts dist/common/
	cp $< $@


dist/host/__snapshots__:
	ln -s ../../host/__snapshots__ $@


host: dist/mobius.js

dist/mobius.js: mobius.ts $(call scripts, host) $(call scripts, common) $(call declarations, server) $(call declarations, types) tsconfig-host.json
	node_modules/.bin/tsc -p tsconfig-host.json
	chmod +x dist/mobius.js


fallback: dist/fallback.min.js

dist/:
	mkdir -p dist/

dist/diff-match-patch.js: dist/
	grep -v module.exports node_modules/diff-match-patch/index.js > $@

dist/fallback.js: mobius-fallback.ts dist/diff-match-patch.js types/*.d.ts tsconfig-fallback.json dist/
	node_modules/.bin/tsc -p tsconfig-fallback.json

dist/fallback.min.js: dist/fallback.js
	node_modules/.bin/google-closure-compiler-js --languageOut ES3 --jsCode $< > $@


docs: host node_modules/typedoc/dist/
	dist/mobius.js --generate-docs

node_modules/typedoc/dist/:
	cd node_modules/typedoc && grunt

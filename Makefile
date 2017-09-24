.PHONY: all run clean cleaner minify client server app fallback

rwildcard=$(foreach d,$(wildcard $1*),$(call rwildcard,$d/,$2) $(filter $(subst *,%,$2),$d))
scripts=$(call rwildcard, $1/, *.tsx) $(call rwildcard, $1/, *.ts)

COMMON_FILES = $(call scripts, common)
CLIENT_FILES = $(call scripts, client)
SERVER_FILES = $(call scripts, server)
HOST_FILES = $(call scripts, host)
SRC_FILES = $(call scripts, src)

all: server client fallback app
minify: public/client.min.js public/fallback.min.js all

run: all
	node --trace-warnings --inspect build/host/index.js

clean:
	rm -rf public/{client,fallback,app}{,.min}.js api/ {common,host,client,src}/*.js build/ types/host/

cleaner: clean
	rm -rf node_modules
	pushd preact && npm run-script clean


node_modules/typescript/bin/tsc: package.json
	npm install && touch node_modules/typescript/bin/tsc


preact/package.json: .gitmodules
	git submodule update --init --recursive preact && touch preact/package.json

preact/dist/preact.js: preact/package.json
	# Global tools that preact requires be available
	npm install -g npm-run-all rollup babel-cli jscodeshift gzip-size-cli rimraf
	pushd preact && npm install

node_modules/preact/dist/preact.d.ts: preact/dist/preact.js
	pushd preact && npm run copy-typescript-definition

node_modules/preact: node_modules/typescript/bin/tsc preact/dist/preact.js
	mkdir -p node_modules
	pushd node_modules && ln -sf ../preact/ preact


api/:
	mkdir -p api/client


server: build/src/app.js

build/.server/:
	mkdir -p build/.server

build/.server/src/app.js: $(SRC_FILES) $(SERVER_FILES) $(HOST_FILES) $(COMMON_FILES) api/ build/.server/ types/*.d.ts tsconfig-server.json node_modules/typescript/bin/tsc node_modules/preact node_modules/preact/dist/preact.d.ts
	node_modules/.bin/tsc -p tsconfig-server.json

build/src/app.js: build/.server/src/app.js
	node_modules/.bin/babel build/.server/ --out-dir build/


client: public/client.js

build/.client/:
	mkdir -p build/.client

build/.client/client/mobius.js: $(SRC_FILES) $(CLIENT_FILES) $(COMMON_FILES) api/ build/.client types/*.d.ts tsconfig-client.json node_modules/typescript/bin/tsc node_modules/preact node_modules/preact/dist/preact.d.ts
	node_modules/.bin/tsc -p tsconfig-client.json

public/client.js: build/.client/client/mobius.js build/.client/src/app.js rollup.config.js
	node_modules/.bin/rollup -c


fallback: public/fallback.js

build/diff-match-patch.js: node_modules/typescript/bin/tsc
	grep -v module.exports node_modules/diff-match-patch/index.js > $@

public/fallback.js: mobius-fallback.ts build/diff-match-patch.js types/*.d.ts tsconfig-fallback.json node_modules/typescript/bin/tsc
	node_modules/.bin/tsc -p tsconfig-fallback.json


app: build/.client/src/app.js

build/.client/src/app.js: $(SRC_FILES) $(SERVER_FILES) $(COMMON_FILES) build/.client/client/mobius.js types/*.d.ts tsconfig-app.json node_modules/typescript/bin/tsc node_modules/preact node_modules/preact/dist/preact.d.ts
	node_modules/.bin/tsc -p tsconfig-app.json


%.min.js: %.js Makefile
	node ./node_modules/google-closure-compiler-js/cmd.js --languageIn ES5 --languageOut ES3 --assumeFunctionWrapper true --rewritePolyfills false $< > $@

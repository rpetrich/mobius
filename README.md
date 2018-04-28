# Mobius

An integrated framework for building web applications, where the DOM, networking, and client/server are abstracted via lockstep execution.

[![Build Status](https://travis-ci.org/rpetrich/mobius.svg?branch=master)](https://travis-ci.org/rpetrich/mobius)

**Status:** Beta

### Getting Started
```bash
# Install globally
npm install -g mobius-js
# Create new project in current directory
mobius --init
# Start service
npm start
```

### Examples
#### Bento Box
[rpetrich/mobius-sample](https://github.com/rpetrich/mobius-sample)

#### Simple
```typescript
import * as dom from "dom";
import { db } from "secrets";
import { modify, query, Credentials } from "sql";

export default class extends dom.Component<{}, { state: number }> {
	state = { clicks: 0 }
	componentDidMount() {
		this.fetchClicks();
	}
	async fetchClicks() {
		const records = await query(db, "SELECT count FROM counter");
		this.setState({ clicks: records[0].count });
	}
	onClick: async () => {
		this.setState({ clicks: this.state.clicks + 1 });
		await modify(db, "UPDATE counter SET count = count + 1");
		this.fetchClicks();
	}
	render() {
		return <button onclick={this.onClick}>
			{this.state.clicks}
		</button>
	}
}
```

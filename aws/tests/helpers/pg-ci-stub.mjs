/**
 * Test-only pg stand-in for Deployment Guard CI, which runs node --test
 * without npm install. Production modules still import 'pg'; this stub
 * satisfies that import and refuses accidental real connections.
 */
class Client {
  constructor() {
    throw new Error('pg CI stub: Client must not be constructed; inject createClient');
  }
}

const types = {
  setTypeParser() {},
};

const pg = { Client, types };
export default pg;
export { Client, types };

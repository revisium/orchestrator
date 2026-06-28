// Project-local eslint rules, exposed as the `local` plugin in eslint.config.mjs.
import noDeadPointers from './no-dead-pointers.js';

export default {
  rules: {
    'no-dead-pointers': noDeadPointers,
  },
};

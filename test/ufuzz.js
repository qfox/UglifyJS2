// ufuzz.js
// derived from https://github.com/qfox/uglyfuzzer by Peter van der Zee
"use strict";

// check both cli and file modes of nodejs (!). See #1695 for details. and the various settings of uglify.
// bin/uglifyjs s.js -c && bin/uglifyjs s.js -c passes=3 && bin/uglifyjs s.js -c passes=3 -m
// cat s.js | node && node s.js && bin/uglifyjs s.js -c | node && bin/uglifyjs s.js -c passes=3 | node && bin/uglifyjs s.js -c passes=3 -m | node

// workaround for tty output truncation upon process.exit()
[process.stdout, process.stderr].forEach(function(stream){
    if (stream._handle && stream._handle.setBlocking)
        stream._handle.setBlocking(true);
});

var vm = require("vm");
var minify = require("..").minify;

var MAX_GENERATED_TOPLEVELS_PER_RUN = 3;
var MAX_GENERATION_RECURSION_DEPTH = 12;
var INTERVAL_COUNT = 100;

var STMT_BLOCK = 0;
var STMT_IF_ELSE = 1;
var STMT_DO_WHILE = 2;
var STMT_WHILE = 3;
var STMT_FOR_LOOP = 4;
var STMT_SEMI = 5;
var STMT_EXPR = 6;
var STMT_SWITCH = 7;
var STMT_VAR = 8;
var STMT_RETURN_ETC = 9;
var STMT_FUNC_EXPR = 10;
var STMT_TRY = 11;
var STMT_C = 12;
var STMT_ALL = [
    STMT_BLOCK,
    STMT_IF_ELSE,
    STMT_DO_WHILE,
    STMT_WHILE,
    STMT_FOR_LOOP,
    STMT_SEMI,
    STMT_EXPR,
    STMT_SWITCH,
    STMT_VAR,
    STMT_RETURN_ETC,
    STMT_FUNC_EXPR,
    STMT_TRY,
    STMT_C,
];
var STMT_ARG_TO_ID = {
    block: STMT_BLOCK,
    ifelse: STMT_IF_ELSE,
    dowhile: STMT_DO_WHILE,
    while: STMT_WHILE,
    forloop: STMT_FOR_LOOP,
    semi: STMT_SEMI,
    expr: STMT_EXPR,
    switch: STMT_SWITCH,
    var: STMT_VAR,
    stop: STMT_RETURN_ETC,
    funcexpr: STMT_FUNC_EXPR,
    try: STMT_TRY,
    c: STMT_C,
};

var STMT_FIRST_LEVEL_OVERRIDE = -1;
var STMT_SECOND_LEVEL_OVERRIDE = -1;

var num_iterations = +process.argv[2] || 1/0;
var verbose = false; // log every generated test
var verbose_interval = false; // log every 100 generated tests
var enable_beautifier = false; // run beautifier as well?
for (var i = 0; i < process.argv.length; ++i) {
    switch (process.argv[i]) {
        case '-v':
            verbose = true;
            break;
        case '-V':
            verbose_interval = true;
            break;
        case '-b':
            enable_beautifier = true;
            break;
        case '-t':
            MAX_GENERATED_TOPLEVELS_PER_RUN = +process.argv[++i];
            if (!MAX_GENERATED_TOPLEVELS_PER_RUN) throw new Error('Must generate at least one toplevel per run');
            break;
        case '-r':
            MAX_GENERATION_RECURSION_DEPTH = +process.argv[++i];
            if (!MAX_GENERATION_RECURSION_DEPTH) throw new Error('Recursion depth must be at least 1');
            break;
        case '-s1':
            var name = process.argv[++i];
            STMT_FIRST_LEVEL_OVERRIDE = STMT_ARG_TO_ID[name];
            if (!(STMT_FIRST_LEVEL_OVERRIDE >= 0)) throw new Error('Unknown statement name; use -? to get a list');
            break;
        case '-s2':
            var name = process.argv[++i];
            STMT_SECOND_LEVEL_OVERRIDE = STMT_ARG_TO_ID[name];
            if (!(STMT_SECOND_LEVEL_OVERRIDE >= 0)) throw new Error('Unknown statement name; use -? to get a list');
            break;
        case '-?':
            console.log('** UglifyJS fuzzer help **');
            console.log('Valid options (optional):');
            console.log('<number>: generate this many cases (if used must be first arg)');
            console.log('-v: print every generated test case');
            console.log('-V: print every 100th generated test case');
            console.log('-b: also run beautifier');
            console.log('-t <int>: generate this many toplevels per run (more take longer)');
            console.log('-r <int>: maximum recursion depth for generator (higher takes longer)');
            console.log('-s1 <statement name>: force the first level statement to be this one (see list below)');
            console.log('-s2 <statement name>: force the second level statement to be this one (see list below)');
            console.log('List of accepted statement names: ' + Object.keys(STMT_ARG_TO_ID));
            console.log('** UglifyJS fuzzer exiting **');
            return 0;
    }
}

var VALUES = [
    'true',
    'false',
    '22',
    '0',
    '-0', // 0/-0 !== 0
    '23..toString()',
    '24 .toString()',
    '25. ',
    '0x26.toString()',
    '(-1)',
    'NaN',
    'undefined',
    'Infinity',
    'null',
    '[]',
    '[,0][1]', // an array with elisions... but this is always false
    '([,0].length === 2)', // an array with elisions... this is always true
    '({})', // wrapped the object causes too many syntax errors in statements
    '"foo"',
    '"bar"' ];

var BINARY_OPS_NO_COMMA = [
    ' + ', // spaces needed to disambiguate with ++ cases (could otherwise cause syntax errors)
    ' - ',
    '/',
    '*',
    '&',
    '|',
    '^',
    '<<',
    '>>',
    '>>>',
    '%',
    '&&',
    '||',
    '^' ];

var BINARY_OPS = [','].concat(BINARY_OPS_NO_COMMA);

var ASSIGNMENTS = [
    '=',
    '=',
    '=',
    '=',
    '=',
    '=',

    '==',
    '!=',
    '===',
    '!==',
    '+=',
    '-=',
    '*=',
    '/=',
    '&=',
    '|=',
    '^=',
    '<<=',
    '>>=',
    '>>>=',
    '%=' ];

var UNARY_OPS = [
    '--',
    '++',
    '~',
    '!',
    'void ',
    'delete ', // should be safe, even `delete foo` and `delete f()` shouldn't crash
    ' - ',
    ' + ' ];

var NO_COMMA = true;
var MAYBE = true;
var CAN_THROW = true;
var CANNOT_THROW = false;
var CAN_BREAK = true;
var CANNOT_BREAK = false;
var CAN_CONTINUE = true;
var CANNOT_CONTINUE = false;
var CANNOT_RETURN = true;
var NOT_GLOBAL = true;
var IN_GLOBAL = true;
var ANY_TYPE = false;
var NO_DECL = true;

var VAR_NAMES = [
    'foo',
    'bar',
    'a',
    'b',
    'c', // prevent redeclaring this, avoid assigning to this
    'undefined', // fun!
    'eval', // mmmm, ok, also fun!
    'NaN', // mmmm, ok, also fun!
    'Infinity', // the fun never ends!
    'arguments', // this one is just creepy
    'Math', // since Math is assumed to be a non-constructor/function it may trip certain cases
    'let' ]; // maybe omit this, it's more a parser problem than minifier

var TYPEOF_OUTCOMES = [
    'undefined',
    'string',
    'number',
    'object',
    'boolean',
    'special',
    'unknown',
    'symbol',
    'crap' ];

var FUNC_TOSTRING = [
    "Function.prototype.toString = function() {",
    "    var ids = [];",
    "    return function() {",
    "        var i = ids.indexOf(this);",
    "        if (i < 0) {",
    "            i = ids.length;",
    "            ids.push(this);",
    "        }",
    '        return "[Function: __func_" + i + "__]";',
    "    }",
    "}();",
    ""
].join("\n");
var loops = 0;
var funcs = 0;

function run_code(code) {
    var stdout = "";
    var original_write = process.stdout.write;
    process.stdout.write = function(chunk) {
        stdout += chunk;
    };
    try {
        new vm.Script(FUNC_TOSTRING + code).runInNewContext({
            console: {
                log: function() {
                    return console.log.apply(console, [].map.call(arguments, function(arg) {
                        return typeof arg == "function" ? "[Function]" : arg;
                    }));
                }
            }
        }, { timeout: 5000 });
        return stdout;
    } catch (ex) {
        return ex;
    } finally {
        process.stdout.write = original_write;
    }
}

function rng(max) {
    return Math.floor(max * Math.random());
}

function createTopLevelCodes(n) {
    var s = '';
    while (n-- > 0) {
        s += createTopLevelCode() + '\n\n//$$$$$$$$$$$$$$\n\n';
    }
    return s;
}

function createTopLevelCode() {
    var r = rng(3);
    if (r > 0) return createFunctions(rng(MAX_GENERATED_TOPLEVELS_PER_RUN) + 1, MAX_GENERATION_RECURSION_DEPTH, IN_GLOBAL, ANY_TYPE, CANNOT_THROW);
    return createStatements(3, MAX_GENERATION_RECURSION_DEPTH, CANNOT_THROW, CANNOT_BREAK, CANNOT_CONTINUE, CANNOT_RETURN);
}

function createFunctions(n, recurmax, inGlobal, noDecl, canThrow) {
    if (--recurmax < 0) { return ';'; }
    var s = '';
    while (n-- > 0) {
        s += createFunction(recurmax, inGlobal, noDecl, canThrow) + '\n';
    }
    return s;
}

function createFunction(recurmax, inGlobal, noDecl, canThrow) {
    if (--recurmax < 0) { return ';'; }
    var func = funcs++;
    var namesLenBefore = VAR_NAMES.length;
    var name = (inGlobal || rng(5) > 0) ? 'f' + func : createVarName();
    if (name === 'a' || name === 'b' || name === 'c') name = 'f' + func; // quick hack to prevent assignment to func names of being called
    if (inGlobal && name === 'undefined' || name === 'NaN' || name === 'Infinity') name = 'f' + func; // cant redefine these in global space
    var s = '';
    if (rng(5) === 1) {
        // functions with functions. lower the recursion to prevent a mess.
        s = 'function ' + name + '(' + createVarName() + '){' + createFunctions(rng(5) + 1, recurmax, NOT_GLOBAL, ANY_TYPE, canThrow) + '}\n';
    } else {
        // functions with statements
        s = 'function ' + name + '(' + createVarName() + '){' + createStatements(3, recurmax) + '}\n';
    }

    if (noDecl) s = '!' + s + '(' + createExpression(recurmax) + ')';
    // avoid "function statements" (decl inside statements)
    else if (inGlobal || rng(10) > 0) s += name + '();'

    VAR_NAMES.length = namesLenBefore;

    return s;
}

function createStatements(n, recurmax, canThrow, canBreak, canContinue, cannotReturn) {
    if (--recurmax < 0) { return ';'; }
    var s = '';
    while (--n > 0) {
        s += createStatement(recurmax, canThrow, canBreak, canContinue, cannotReturn);
    }
    return s;
}

function createStatement(recurmax, canThrow, canBreak, canContinue, cannotReturn) {
    var loop = ++loops;
    if (--recurmax < 0) {
        return createExpression(recurmax) + ';';
    }

    // allow to forcefully generate certain structures at first or second recursion level
    // note: createStatement_s_ also reduces the recursion counter by 1
    var target = 0;
    if (recurmax === MAX_GENERATION_RECURSION_DEPTH-2 && STMT_FIRST_LEVEL_OVERRIDE >= 0) target = STMT_FIRST_LEVEL_OVERRIDE;
    else if (recurmax === MAX_GENERATION_RECURSION_DEPTH-4 && STMT_SECOND_LEVEL_OVERRIDE >= 0) target = STMT_SECOND_LEVEL_OVERRIDE;
    else target = STMT_ALL[rng(STMT_ALL.length)];

    switch (target) {
        case STMT_BLOCK:
            return '{' + createStatements(rng(5) + 1, recurmax, canThrow, canBreak, canContinue, cannotReturn) + '}';
        case STMT_IF_ELSE:
            return 'if (' + createExpression(recurmax) + ')' + createStatement(recurmax, canThrow, canBreak, canContinue, cannotReturn) + (rng(2) === 1 ? ' else ' + createStatement(recurmax, canThrow, canBreak, canContinue, cannotReturn) : '');
        case STMT_DO_WHILE:
            return '{var brake' + loop + ' = 5; do {' + createStatement(recurmax, canThrow, CAN_BREAK, CAN_CONTINUE, cannotReturn) + '} while ((' + createExpression(recurmax) + ') && --brake' + loop + ' > 0);}';
        case STMT_WHILE:
            return '{var brake' + loop + ' = 5; while ((' + createExpression(recurmax) + ') && --brake' + loop + ' > 0)' + createStatement(recurmax, canThrow, CAN_BREAK, CAN_CONTINUE, cannotReturn) + '}';
        case STMT_FOR_LOOP:
            return 'for (var brake' + loop + ' = 5; (' + createExpression(recurmax) + ') && brake' + loop + ' > 0; --brake' + loop + ')' + createStatement(recurmax, canThrow, CAN_BREAK, CAN_CONTINUE, cannotReturn);
        case STMT_SEMI:
            return ';';
        case STMT_EXPR:
            return createExpression(recurmax) + ';';
        case STMT_SWITCH:
            // note: case args are actual expressions
            // note: default does not _need_ to be last
            return 'switch (' + createExpression(recurmax) + ') { ' + createSwitchParts(recurmax, 4, canThrow, canBreak, canContinue, cannotReturn) + '}';
        case STMT_VAR:
            switch (rng(3)) {
                case 0:
                    var name = createVarName();
                    if (name === 'c') name = 'a';
                    return 'var ' + name + ';';
                case 1:
                    // initializer can only have one expression
                    var name = createVarName();
                    if (name === 'c') name = 'b';
                    return 'var ' + name + ' = ' + createExpression(recurmax, NO_COMMA) + ';';
                default:
                    // initializer can only have one expression
                    var n1 = createVarName();
                    if (n1 === 'c') n1 = 'b';
                    var n2 = createVarName();
                    if (n2 === 'c') n2 = 'b';
                    return 'var ' + n1 + ' = ' + createExpression(recurmax, NO_COMMA) + ', ' + n2 + ' = ' + createExpression(recurmax, NO_COMMA) + ';';
            }
        case STMT_RETURN_ETC:
            switch (rng(3)) {
                case 1:
                    if (canBreak && rng(5) === 0) return 'break;';
                    if (canContinue && rng(5) === 0) return 'continue;';
                    if (cannotReturn) return createExpression(recurmax) + ';';
                    return '/*3*/return;';
                case 2:
                    // must wrap in curlies to prevent orphaned `else` statement
                    if (canThrow && rng(5) === 0) return '{ throw ' + createExpression(recurmax) + '}';
                    if (cannotReturn) return createExpression(recurmax) + ';';
                    return '{ /*1*/ return ' + createExpression(recurmax) + '}';
                default:
                    // this is actually more like a parser test, but perhaps it hits some dead code elimination traps
                    // must wrap in curlies to prevent orphaned `else` statement
                    // note: you can't `throw` without an expression so don't put a `throw` option in this case
                    if (cannotReturn) return createExpression(recurmax) + ';';
                    return '{ /*2*/ return\n' + createExpression(recurmax) + '}';
            }
        case STMT_FUNC_EXPR:
            // "In non-strict mode code, functions can only be declared at top level, inside a block, or ..."
            // (dont both with func decls in `if`; it's only a parser thing because you cant call them without a block)
            return '{' + createFunction(recurmax, NOT_GLOBAL, NO_DECL, canThrow) + '}';
        case STMT_TRY:
            // catch var could cause some problems
            // note: the "blocks" are syntactically mandatory for try/catch/finally
            var n = rng(3); // 0=only catch, 1=only finally, 2=catch+finally
            var s = 'try {' + createStatement(recurmax, n === 1 ? CANNOT_THROW : CAN_THROW, canBreak, canContinue, cannotReturn) + ' }';
            if (n !== 1) s += ' catch (' + createVarName() + ') { ' + createStatements(3, recurmax, canThrow, canBreak, canContinue, cannotReturn) + ' }';
            if (n !== 0) s += ' finally { ' + createStatements(3, recurmax, canThrow, canBreak, canContinue, cannotReturn) + ' }';
            return s;
        case STMT_C:
            return 'c = c + 1;';
        default:
            throw 'no';
    }
}

function createSwitchParts(recurmax, n, canThrow, canBreak, canContinue, cannotReturn) {
    var hadDefault = false;
    var s = '';
    while (n-- > 0) {
        //hadDefault = n > 0; // disables weird `default` clause positioning (use when handling destabilizes)
        if (hadDefault || rng(5) > 0) {
            s += '' +
                'case ' + createExpression(recurmax) + ':\n' +
                createStatements(rng(3) + 1, recurmax, canThrow, CAN_BREAK, canContinue, cannotReturn) +
                '\n' +
                (rng(10) > 0 ? ' break;' : '/* fall-through */') +
                '\n';
        } else {
            hadDefault = true;
            s += '' +
                'default:\n' +
                createStatements(rng(3) + 1, recurmax, canThrow, CAN_BREAK, canContinue, cannotReturn) +
                '\n';
        }
    }
    return s;
}

function createExpression(recurmax, noComma) {
    if (--recurmax < 0) {
        return '(c = 1 + c, ' + createValue() + ')'; // note: should return a simple non-recursing expression value!
    }
    // since `a` and `b` are our canaries we want them more frequently than other expressions (1/3rd chance of a canary)
    let r = rng(6);
    if (r < 1) return 'a++ + ' + _createExpression(recurmax, noComma);
    if (r < 2) return '(--b) + ' + _createExpression(recurmax, noComma);
    if (r < 3) return '(c = c + 1) + ' + _createExpression(recurmax, noComma); // c only gets incremented

    return _createExpression(recurmax, noComma);
}
function _createExpression(recurmax, noComma) {
    switch (rng(12)) {
        case 0:
            return createUnaryOp() + (rng(2) === 1 ? 'a' : 'b');
        case 1:
            return 'a' + (rng(2) == 1 ? '++' : '--');
        case 2:
            // parens needed because assignments aren't valid unless they're the left-most op(s) in an expression
            return '(b ' + createAssignment() + ' a)';
        case 3:
            return rng(2) + ' === 1 ? a : b';
        case 4:
            return createExpression(recurmax, noComma) + createBinaryOp(noComma) + createExpression(recurmax, noComma);
        case 5:
            return createValue();
        case 6:
            return '(' + createExpression(recurmax) + ')';
        case 7:
            return createExpression(recurmax, noComma) + '?' + createExpression(recurmax, NO_COMMA) + ':' + createExpression(recurmax, noComma);
        case 8:
            let name = createVarName(MAYBE);
            if (name === 'c') name = 'a';
            switch(rng(4)) {
                case 0:
                    return '(function ' + name + '(){' + createStatements(rng(5) + 1, recurmax) + '})()';
                case 1:
                    return '+function ' + name + '(){' + createStatements(rng(5) + 1, recurmax) + '}';
                case 2:
                    return '!function ' + name + '(){' + createStatements(rng(5) + 1, recurmax) + '}';
                case 3:
                    return 'void function ' + name + '(){' + createStatements(rng(5) + 1, recurmax) + '}';
                default:
                    return 'void function ' + name + '(){' + createStatements(rng(5) + 1, recurmax) + '}';
            }
        case 9:
            return createTypeofExpr();
        case 10:
            // you could statically infer that this is just `Math`, regardless of the other expression
            // I don't think Uglify does this at this time...
            return ''+
                'new function(){ \n' +
                (rng(2) === 1 ? createExpression(recurmax) + '\n' : '') +
                'return Math;\n' +
                '}';
        case 11:
            // more like a parser test but perhaps comment nodes mess up the analysis?
            // note: parens not needed for post-fix (since that's the default when ambiguous)
            // for prefix ops we need parens to prevent accidental syntax errors.
            switch (rng(6)) {
                case 0:
                    return 'a/* ignore */++';
                case 1:
                    return 'b/* ignore */--';
                case 2:
                    return '(++/* ignore */a)';
                case 3:
                    return '(--/* ignore */b)';
                case 4:
                    // only groups that wrap a single variable return a "Reference", so this is still valid.
                    // may just be a parser edge case that is invisible to uglify...
                    return '(--(b))';
                case 5:
                    // classic 0.3-0.1 case; 1-0.1-0.1-0.1 is not 0.7 :)
                    return 'b + 1-0.1-0.1-0.1';
                default:
                    return '(--/* ignore */b)';
            }
    }
}

function createTypeofExpr() {
    switch (rng(5)) {
        case 0:
            return 'typeof ' + createVarName() + ' === "' + TYPEOF_OUTCOMES[rng(TYPEOF_OUTCOMES.length)] + '"';
        case 1:
            return 'typeof ' + createVarName() + ' !== "' + TYPEOF_OUTCOMES[rng(TYPEOF_OUTCOMES.length)] + '"';
        case 2:
            return 'typeof ' + createVarName() + ' == "' + TYPEOF_OUTCOMES[rng(TYPEOF_OUTCOMES.length)] + '"';
        case 3:
            return 'typeof ' + createVarName() + ' != "' + TYPEOF_OUTCOMES[rng(TYPEOF_OUTCOMES.length)] + '"';
        case 4:
            return 'typeof ' + createVarName();
    }
}

function createValue() {
    return VALUES[rng(VALUES.length)];
}

function createBinaryOp(noComma) {
    if (noComma) return BINARY_OPS_NO_COMMA[rng(BINARY_OPS_NO_COMMA.length)];
    return BINARY_OPS[rng(BINARY_OPS.length)];
}

function createAssignment() {
    return ASSIGNMENTS[rng(ASSIGNMENTS.length)];
}

function createUnaryOp() {
    return UNARY_OPS[rng(UNARY_OPS.length)];
}

function createVarName(maybe) {
    if (!maybe || rng(2) === 1) {
        var r = rng(VAR_NAMES.length);
        var name = VAR_NAMES[r] + (rng(5) > 0 ? '_' + (++loops): '');
        VAR_NAMES.push(name);
        return name;
    }
    return '';
}

function log(ok) {
    if (!ok) console.log('\n\n\n\n\n\n!!!!!!!!!!\n\n\n');
    console.log("//=============================================================");
    if (!ok) console.log("// !!!!!! Failed... round", round);
    console.log("// original code");
    console.log("//");
    console.log(original_code);
    console.log();
    console.log();
    if (enable_beautifier) {
        console.log("//-------------------------------------------------------------");
        console.log("// original code (beautify'd)");
        console.log("//");
        console.log(beautify_code);
        console.log();
        console.log();
    }
    console.log("//-------------------------------------------------------------");
    console.log("// uglified code");
    console.log("//");
    console.log(uglify_code);
    console.log();
    console.log();
    console.log("original result:");
    console.log(original_result);
    if (enable_beautifier) {
        console.log("beautified result:");
        console.log(beautify_result);
    }
    console.log("uglified result:");
    console.log(uglify_result);
    if (!ok) console.log("!!!!!! Failed... round", round);
}

var initial_names_len = VAR_NAMES.length;
for (var round = 0; round < num_iterations; round++) {
    var parse_error = false;
    process.stdout.write(round + " of " + num_iterations + "\r");

    VAR_NAMES.length = initial_names_len; // prune any previous names still in the list
    loops = 0;
    funcs = 0;

    var original_code = [
        "var a = 100, b = 10, c = 0;",
        createTopLevelCodes(rng(MAX_GENERATED_TOPLEVELS_PER_RUN) + 1) +
        "console.log(null, a, b, c);" // the array makes for a cleaner output (empty string still shows up etc)
    ].join("\n");
    var original_result = run_code(original_code);

    if (enable_beautifier) {
        try {
            var beautify_code = minify(original_code, {
                fromString: true,
                mangle: false,
                compress: false,
                output: {
                    beautify: true,
                    bracketize: true,
                },
            }).code;
        } catch(e) {
            parse_error = 1;
        }
        var beautify_result = run_code(beautify_code);
    } else {
        var beautify_result = original_result;
    }

    try {
      var uglify_code = minify(original_code, {
          fromString: true,
          mangle: true,
          compress: {
              passes: 3,
          },
          output: {
              //beautify: true,
              //bracketize: true,
          },
      }).code;
    } catch(e) {
        parse_error = 2;
    }
    var uglify_result = run_code(uglify_code);

    var ok = !parse_error && original_result == beautify_result && original_result == uglify_result;
    //if (!ok && typeof original_result === 'string' && original_result.indexOf('[Function:') >= 0) ok = true;
    if (verbose || (verbose_interval && !(round % INTERVAL_COUNT)) || !ok) log(ok);
    if (parse_error === 1) console.log('Parse error while beautifying');
    if (parse_error === 2) console.log('Parse error while uglifying');
    if (!ok) break;
}

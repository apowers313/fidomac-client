/* JSHINT */
/* exported FidoMacClient, U2FApduMessage */
var FidoMacClient, U2FApduMessage;
(function() { /// IIFE

    /**
     * Queue
     *
     * A message queue for incoming messages
     * getMessage will return a promise that will resolve to a message
     * putMessage will queue the message if nobody is waiting, or resolve a promise if someone is waiting
     */
    class Queue {
        constructor() {
            this.waitQueue = [];
            this.msgQueue = [];
        }

        get messageLength() {
            return this.msgQueue.length;
        }

        get clientLength() {
            return this.waitQueue.length;
        }

        getMessage() {
            return new Promise((resolve, reject) => {
                if (this.msgQueue.length > 0) {
                    console.log("Had message waiting");
                    var msg = this.msgQueue.shift();
                    resolve(msg);
                } else {
                    console.log("No message waiting, queueing client");
                    var client = {
                        resolve: resolve,
                        reject: reject
                    };
                    this.waitQueue.push(client);
                }
            });
        }

        putMessage(msg) {
            if (this.waitQueue.length > 0) {
                console.log("Client was waiting");
                var client = this.waitQueue.shift();
                client.resolve(msg);
            } else {
                console.log("No client waiting, queueing message");
                this.msgQueue.push(msg);
            }
        }

        flush() {
            this.msgQueue.length = 0;
        }

        error(err) {
            console.log("Wait Queue Length:", this.waitQueue.length);
            while (this.waitQueue.length) {
                var client = this.waitQueue.shift();
                console.log(client);
                client.reject(err);
            }
        }
    }

    /**
     * FidoMacClient
     *
     * A client for sending / receiving messages to / from
     * the FIDO Manager for Authenticator Communications (MAC)
     */
    FidoMacClient = class FidoMacClient {
        constructor(url) {
            this.ws = new WebSocket(url);
            this.ws.binaryType = "arraybuffer";
            this.queue = new Queue();

            this.ws.onopen = function(event) {
                console.log("open for business", event);
                var e = new CustomEvent("fidomac-ready", { "detail": event });
                document.dispatchEvent(e);
                // elem.addEventListener('build', function (e) { ... }, false);
            };

            this.ws.onerror = function(e) {
                console.log("ERROR: error receiving transport message on WebSocket:" + e.data);
                console.log(e);
                console.log(e.data);
                // XXX kill all clients because of an error? not sure if all errors are fatal
                this.queue.error(e.data);
            };

            this.ws.onclose = function(e) {
                console.log("Closed:");
                console.log(e);
                this.queue.error(new Error(e.data));
            };

            this.ws.onmessage = (e) => {
                console.log("Got message:");
                console.log(e.data);
                if (e.data instanceof ArrayBuffer) {
                    console.log("data was ArrayBuffer");
                    var msg = new Uint8Array(e.data);
                    console.log(msg);
                    printHex("response", msg);
                    this.queue.putMessage(msg);
                }
            };
        } // end Queue class

        sendRawTransportMessage(msg, transport = "any") {
            return new Promise((resolve, reject) => {
                //         console.log(msg.proto)

                var payload = msg.payload;
                var buf, len;
                if (ArrayBuffer.isView(payload) && payload.buffer instanceof ArrayBuffer) {
                    payload = payload.buffer;
                }
                if (typeof payload === "string") {
                    len = payload.length;
                    buf = new ArrayBuffer(6 + len);
                    payload = new Uint8Array(buf, 6);
                    msg.payload.split("").forEach((val, idx) => {
                        payload[idx + 6] = val.charCodeAt(0);
                    });
                    // new ArrayBuffer from string
                } else if (payload instanceof ArrayBuffer) {
                    len = payload.byteLength;
                    buf = new Uint8Array(6 + len);
                    buf.set(new Uint8Array(payload), 6);
                    console.log("payload:", payload);
                    console.log("set buffer:", buf);
                } else {
                    // TODO handle TypedArrays
                    throw (new TypeError("unsupported payload type"));
                }
                console.log("Payload:", payload);
                console.log("Length:", len);

                if (typeof payload !== "object" && payload instanceof ArrayBuffer) {
                    return reject(new TypeError("Expected message payload to be a String or ArrayBuffer: " + typeof payload));
                }

                var cmd = msg.cmd;
                if (typeof cmd === "string") switch (cmd) {
                    case "U2F_APDU":
                        cmd = 0x00;
                        break;
                    case "U2F_PING":
                        cmd = 0x01;
                        break;
                    default:
                        return reject(new TypeError("Unexpected message command: " + cmd));
                }

                if (typeof cmd !== "number") {
                    return reject(new TypeError("Expected message command to be a number: " + msg.cmd));
                }
                console.log("Cmd:", cmd);

                var transportByte;
                console.log("transport:", transport);
                switch (true) {
                    case /any/i.test(transport):
                        transportByte = 0xFF;
                        break;
                    case /usb/i.test(transport):
                        transportByte = 0x01;
                        break;
                    case /nfc/i.test(transport):
                        transportByte = 0x02;
                        break;
                    case /ble/i.test(transport):
                        transportByte = 0x03;
                        break;
                    default:
                        return reject(new TypeError("Unknown transport type: " + transport));
                }

                console.log(buf.buffer);
                console.log(buf.buffer instanceof ArrayBuffer);
                var dv = new DataView(buf.buffer);
                //     unsigned char magic[2];
                //     unsigned char transport;
                //     unsigned char cmd;
                //     unsigned short len;
                //     unsigned char payload[];
                // set header
                dv.setUint8(0, 0xF1); // magic number byte #1
                dv.setUint8(1, 0xD0); // magic number byte #2
                dv.setUint8(2, transportByte); // transport type
                dv.setUint8(3, cmd); // command
                dv.setUint16(4, len, false); // payload length
                //dv.setsomething msg.payloaw

                // send DV? or buffer?
                printHex("raw transport message", dv.buffer);

                this.ws.send(dv);
                // catch response?
                resolve(buf);
            });
        }

        receiveRawTransportMessage() {
            return this.queue.getMessage();
            // TODO: unwrap message
        }
    }; // end FidoMacClient class


    // TODO:
    // -----
    // U2F Message Format
    // CLA
    // INS - instruction
    // P1
    // P2
    // Lc
    // Le
    // Short Encoding
    // Extended Length Encoding

    // Promise sendApdu (apduObj, [transport])
    U2FApduMessage = class U2FApduMessage extends FidoMacClient {
        constructor() {
            super();
        }

        sendApdu(msg) {
            super.sendRawTransportMessage(msg);
        }

        receiveApdu() {
            super.receiveRawTransportMessage();
        }
    };

    function printHex(msg, buf) {
        // if the buffer was a TypedArray (e.g. Uint8Array), grab its buffer and use that
        if (ArrayBuffer.isView(buf) && buf.buffer instanceof ArrayBuffer) {
            buf = buf.buffer;
        }
        // check the arguments
        if ((typeof msg != "string") ||
            (typeof buf != "object")) {
            console.log("Bad args to printHex");
            return;
        }
        if (!(buf instanceof ArrayBuffer)) {
            console.log("Attempted printHex with non-ArrayBuffer");
            return;
        }
        // print the buffer as a 16 byte long hex string
        var arr = new Uint8Array(buf);
        var len = buf.byteLength;
        var i, str = "";
        console.log(msg);
        for (i = 0; i < len; i++) {
            var hexch = arr[i].toString(16);
            hexch = (hexch.length == 1) ? ("0" + hexch) : hexch;
            str += hexch.toUpperCase() + " ";
            if (i && !((i + 1) % 16)) {
                console.log(str);
                str = "";
            }
        }
        // print the remaining bytes
        if ((i) % 16) {
            console.log(str);
        }
    }
})(); // end IIFE
/*rtc.js
real time communication uses WebRTC, see https://en.wikipedia.org/wiki/WebRTC*/
/*jslint
    es6, maxerr: 100, browser, devel, fudge, maxlen: 120, white, node, eval
*/
/*global
    RTCPeerConnection, RTCSessionDescription, RTCIceCandidate
*/

/*todo check with wireshark

include local identifier  ? for a request response pair

catch thrown errors https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/send
try solve problem where one user can send infinite request, by changing answer into request
carefull with `` syntax, properly escape with \
use navigator.onLine and others (rtc requires connection) to not run into
InvalidStateError: Can't create RTCPeerConnections when the network is down

use http://danml.com/download.html to download files on single page
*/

import {MESSAGES} from "./settings/messages.js";
import {state} from "./state.js";
import {keyFromObjectAndValue, OutOfOrderError} from "./utilities/utilities.js";
import bytes from "./bytes.js";
import ui from "./ui.js";
import uiFiles from "./uiFiles.js";
import {socketSendAction} from "./sockets.js";
import browserServer from "./built/browserserver_with_node_emulator_for_worker.js";

export { rtc as default };

const rtc = (function () {
    const API = {
    };

    let useCustom = false;
    let audioContext;
    try {
        audioContext = new AudioContext();//http://stackoverflow.com/questions/40363606/how-to-keep-webrtc-datachannel-open-in-phone-browser-inactive-tab/40563729
    } catch (notUsed) {
        ;//not important
    }
    const SEND_BUFFERED_AMOUNT_LOW_THRESHOLD = 2000; // Bytes
    const MAX_MESSAGE_SIZE = 798; //Bytes some say it should be 800
    const PREFIX_MAX_SIZE = 10; //Bytes
    const MAX_PACKET_LIFETIME = 3000; //ms

    const ORDERED = true;

    const rtcPeerConnectionFromId = {};
    const applicationLevelSendBufferFromDataChannel = new WeakMap();
    const applicationLevelReceivePartsBufferFromDataChannel = new WeakMap();
    const rtcSendDataChannelFromRtcPeerConnection = new WeakMap();
    const rtcSendDataChannelFromId = {//PROXY
        get: function (id) {
            return rtcSendDataChannelFromRtcPeerConnection.get(rtcPeerConnectionFromId[id]);
        },
        has: function (id) {
            return rtcSendDataChannelFromRtcPeerConnection.has(rtcPeerConnectionFromId[id]);
        },
        set: function (id, dataChannel) {
            rtcSendDataChannelFromRtcPeerConnection.set(rtcPeerConnectionFromId[id], dataChannel);
            return dataChannel;
        }
    };
    const resolveFromfileName = {};
    let resendAllRtcRequestsCount = 0;

    /* RTCConfiguration Dictionary see
    https://www.w3.org/TR/webrtc/#rtcconfiguration-dictionary*/
    const RTC_CONFIGURATION = {
        iceServers: [
            { urls: "stun:stun.services.mozilla.com" },
            { urls: "stun:stun.l.google.com:19302" }
        ]
    };

    const M = {
        ANSWER: "answer",
        REQUEST: "request",
        GET: "GET"
    };





//make connected list reappear with the map
    const handleRequestDefault = function (headerBodyObject, fromId) {
        //console.log("headerBodyObject:", headerBodyObject);
        let fileName = headerBodyObject.header.fileName;
        if (fileName === "") {
            fileName = "index.html";
        }
        let answer = uiFiles.fileFromFileName(fileName);
        if (answer) {
            return {
                header: {
                    "Content-Type": answer.header["Content-Type"] ||
                                    uiFiles.contentTypeFromFileName(fileName)
                },
                body: answer.body
            };
        }
        return {
            header: {
                "Content-Type": "text/html",
                status: 404,
                statusText : "NOT FOUND"
            },
            body: `<html><p>Connection Successful ! But /${headerBodyObject.header.fileName} Not found (404)</p></html>`
        };
    };

    const useHandleRequestCustom = function (use) {
        useCustom = use;
    };


    const sendOrPutIntoSendBuffer = function (rtcSendDataChannel,
            data, forcePutIntoSendBuffer = false) {
        /*console.log("sendOrPutIntoSendBuffer", (!forcePutIntoSendBuffer &&
        (rtcSendDataChannel.bufferedAmount <
        rtcSendDataChannel.bufferedAmountLowThreshold)));*/
        if (!forcePutIntoSendBuffer &&
            (rtcSendDataChannel.bufferedAmount <
            rtcSendDataChannel.bufferedAmountLowThreshold)) {
            rtcSendDataChannel.send(data);
            return false;
        } else {
            //console.log(`delayed .send() data.byteLength: ${data.byteLength}`);
            const applicationLevelSendBuffer =
                applicationLevelSendBufferFromDataChannel.get(rtcSendDataChannel);
            applicationLevelSendBuffer.push(data);
            return true;
        }
    };

    const sendDataOverRTC = function (rtcSendDataChannel, data) {
        if (!rtcSendDataChannel || !isOpenFromDataChannel(rtcSendDataChannel)) {
            console.log(rtcSendDataChannel);
            console.log(isOpenFromDataChannel(rtcSendDataChannel));
            console.log("if or");
            console.log(!rtcSendDataChannel);
            console.log(!isOpenFromDataChannel(rtcSendDataChannel));
            ui.displayFatalError("The connection is not open or is it 1");
            return;
        }

        const byteLength = data.byteLength;
        if (typeof data === "string" || byteLength < MAX_MESSAGE_SIZE + PREFIX_MAX_SIZE) {
            // no need to split data we can send all at once
            if (typeof data !== "string") {
                data = bytes.addInternalMessagePrefixToArrayBuffer(data);
            }
            sendOrPutIntoSendBuffer(rtcSendDataChannel, data);
            return;
        }
        // need to split before send
        // todo future split up data when strings if too big if still relevant

        const splitData = bytes.splitArrayBuffer(data, MAX_MESSAGE_SIZE);
        let forcePutIntoSendBuffer = false;
        //https://bugs.chromium.org/p/webrtc/issues/detail?id=6628
        splitData.forEach(function (dataPart) {
            forcePutIntoSendBuffer =
                sendOrPutIntoSendBuffer(rtcSendDataChannel,
                    dataPart,
                    forcePutIntoSendBuffer);
        });

    };


    const prepareSendRtcData = function (targetId, headerBodyObject) {
        //console.log("prepareSendRtcData", headerBodyObject);
        let data;
        if (typeof headerBodyObject.body === "string") {
            /*can be sent as a string without data loss*/
            data = JSON.stringify(headerBodyObject);
        } else {
            /*the body is an arrayBuffer, convert everything into an arrayBuffer*/
            data = bytes.arrayBufferFromHeaderBodyObject(headerBodyObject);
        }
        // data can be DOMString, Blob, ArrayBuffer, ArrayBufferView But NOT Object
        const rtcSendDataChannel = rtcSendDataChannelFromId.get(targetId);
        sendDataOverRTC(rtcSendDataChannel, data);
    };

    const buildTrySendRemaining = function (targetId) {
        //close over targetId
        let trySendRemaining =  function (event) { //TrySendRemaining
            /*gets called when the send buffer is low, see
https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/onbufferedamountlow*/
            const rtcSendDataChannel = rtcSendDataChannelFromId.get(targetId);
            if (rtcSendDataChannel.bufferedAmount
                < rtcSendDataChannel.bufferedAmountLowThreshold) {
                const applicationLevelSendBuffer =
                    applicationLevelSendBufferFromDataChannel.get(rtcSendDataChannel);
                if (applicationLevelSendBuffer.length === 0) {
                    //nothing to send
                    return;
                }
                const data = applicationLevelSendBuffer.shift();
                if (isOpenFromDisplayName(targetId)) {
//console.log(`TrySendRemaining  : ${data.byteLength}`);
                    rtcSendDataChannel.send(data);
                    trySendRemaining();

    //todo recall itself
                } else {
                    ui.displayFatalError("The connection is not open 2 or is it ?");
                }
            }
        };
        return trySendRemaining;
    };


    const receiveRtcData = function (event, from) {
        let data = event.data || event;
        //console.log("receiveRtcData", event, from);
        /*also see prepareSendRtcData*/
        let headerBodyObject;
        let canceled;
        if (typeof data === "string") {
            /*has been sent as a string*/
            headerBodyObject = JSON.parse(data);
        } else {
            /*as arrayBuffer*/

            if (data.size) { //Blob
            /* or blob, if data arrives as blob
            this block should never run*/
                bytes.arrayBufferPromiseFromBlob(data).then(
                function (arrayBuffer) {
                    receiveRtcData(arrayBuffer, from);
                }).catch(function (error) {
                    ui.displayFatalError("bytes.arrayBufferPromiseFromBlob" +
                        error.toString(), error);
                });
                return;
            }
            const prefix = bytes.internalMessagePrefixFromArrayBuffer(data);
            data = bytes.removeInternalMessagePrefixFromArrayBuffer(data);

            /*see bytes.js PREFIX_DICTIONARY*/
            if (prefix !== "standalone") { // part
                const rtcSendDataChannel = rtcSendDataChannelFromId.get(from);
                const applicationLevelReceivePartsBuffer =
                    applicationLevelReceivePartsBufferFromDataChannel.get(
                        rtcSendDataChannel
                    );
                applicationLevelReceivePartsBuffer.push([prefix, data]);
                if (prefix !== "endpart") { // not last part
                    return;
                } else if (prefix === "endpart") { // last part
                    applicationLevelReceivePartsBufferFromDataChannel.set(rtcSendDataChannel, []);
                    try {
                        data = bytes.assembleArrayBuffer(applicationLevelReceivePartsBuffer);
                    } catch (error) {
                        if (error instanceof OutOfOrderError) {
                            resendAllRtcRequests();
                            canceled = true;
                        } else {
                            throw error;
                        }
                    }
                }
            }
            if (canceled) {
                return;
            }
            headerBodyObject = bytes.headerBodyObjectFromArrayBuffer(data);
        }
        //console.log(headerBodyObject);
        if (headerBodyObject.header.is === M.REQUEST) {
            const originalfileName = headerBodyObject.header.fileName;
            if (headerBodyObject.header.method === "MESSAGE") {
                ui.handleMessage(headerBodyObject, from);
            } else if (!(d.variables.localServerAvailability)) {
                ;//do nothing
            } else {
                headerBodyObject.header.fileName = decodeURI(headerBodyObject.header.fileName);

                const sendAnswerObject = function (answerObject) {
                    //console.log("sendAnswerObject", answerObject);
                    if (answerObject) {
                        answerObject.header.is = M.ANSWER;
                        answerObject.header.fileName = originalfileName;
                        prepareSendRtcData(from, answerObject);
                    }
                };
                if (!useCustom) {
                    /*use default request handler*/
                    sendAnswerObject(handleRequestDefault(headerBodyObject, from));
                } else {
                    const answerObjectPromise = browserServer.
                    answerObjectPromiseFromRequest(headerBodyObject, from);
                    //console.log(answerObjectPromise);
                    answerObjectPromise.then(sendAnswerObject).catch(function (reason) {
                        console.log(reason);
                    });
                }
            }

        } else if (headerBodyObject.header.is === M.ANSWER) {
            const fileName = headerBodyObject.header.fileName;
            if (resolveFromfileName.hasOwnProperty(fileName)) {
                resolveFromfileName[fileName](headerBodyObject);
                delete resolveFromfileName[fileName];
            }
        }
    };

    const sendRtcMessage = function (targetId, text) {
        prepareSendRtcData(targetId, {
            header: {
                "is": M.REQUEST,
                "method": "MESSAGE",
                "Content-Type": "text/plain"
            },
            body: text
        });
    };

    const createdDescription = function (description, to) {
        if (!rtcPeerConnectionFromId[to]) {
            return;
        }
        const rtcPeerConnection = rtcPeerConnectionFromId[to];
        rtcPeerConnection.setLocalDescription(description).then(function () {
            socketSendAction(MESSAGES.SEND_DESCRIPTION, {
                sdp: rtcPeerConnection.localDescription,
                displayedName : state.localDisplayedName,
                from: state.localDisplayedName,
                targetDisplayedName: to
            });
        }).catch(function (error) {
                console.log("An error occured", error)
        });

    };

    const startConnectionWith = function (isCaller, to) {
        let rtcPeerConnection;
        let rtcSendDataChannel;
        if (!rtcPeerConnectionFromId[to]) {
            try {
                rtcPeerConnection = new RTCPeerConnection(RTC_CONFIGURATION);
            } catch (error) {
                console.log(error);
                if (error instanceof DOMException && error.name === "InvalidStateError") {
                    rtcPeerConnection = null;
                    ui.markUserAsConnected(to, false);
                    ui.displayFatalError("Network is down, reconnect to the internet and try again.");
                } else {
                    throw error;
                }
            }
            if (!rtcPeerConnection) {
                return;
            }
            rtcPeerConnection.onicecandidate = function (event) {
                if (event.candidate) {
                    //console.log("On ICE 2");
                    socketSendAction(MESSAGES.SEND_ICE_CANDIDATE, {
                        ice: event.candidate,
                        from: state.localDisplayedName,
                        targetId: to
                    });
                }
            };

            rtcSendDataChannel = rtcPeerConnection.createDataChannel("app", {
                ordered: ORDERED,
                maxPacketLifeTime: MAX_PACKET_LIFETIME
            });
            rtcSendDataChannel.bufferedAmountLowThreshold = SEND_BUFFERED_AMOUNT_LOW_THRESHOLD;
            rtcSendDataChannel.binaryType = "arraybuffer";
            applicationLevelSendBufferFromDataChannel.set(rtcSendDataChannel, []);
            applicationLevelReceivePartsBufferFromDataChannel.set(rtcSendDataChannel, [])
            rtcSendDataChannel.onbufferedamountlow = buildTrySendRemaining(to);

            const sendChannelStateChangeHandler = sendChannelStateChange(to);

            rtcSendDataChannel.onopen = sendChannelStateChangeHandler;
            rtcSendDataChannel.onclose = sendChannelStateChangeHandler;

            rtcPeerConnection.ondatachannel = function (event) {
                const receiveChannel = event.channel;
                receiveChannel.onmessage = function (event) {
                    receiveRtcData(event, to);
                };
            };

            rtcSendDataChannel.onmessage = function (event) {
                //never triggers ?
                console.log("Receive data from rtcSendDataChannel", event.data);
            };

            rtcPeerConnectionFromId[to] = rtcPeerConnection;
            rtcSendDataChannelFromId.set(to, rtcSendDataChannel);
        } else {
            rtcPeerConnection = rtcPeerConnectionFromId[to];
        }

        if (isCaller) {
            rtcPeerConnection.createOffer()
            .then(function (description) {
                createdDescription(description, to);
                //console.log("Description created 1");
            })
            .catch(function (error) {
                console.log("An error occured", error)
            });
        }

    }



    const sendChannelStateChange = function (peerDisplayedName) {
        return () => {
            //console.log(`Send channel state is open: ${open}`);
            ui.markUserAsConnected(peerDisplayedName, isOpenFromDisplayName(peerDisplayedName));
            ui.selectAfterConnected(peerDisplayedName);
        };
    };

    const onReceiveRtcConnectionDescription = function (data) {
        if (!rtcPeerConnectionFromId[data.from]) {
            startConnectionWith(false, data.from);
        }

        const rtcPeerConnection = rtcPeerConnectionFromId[data.from];
        if (rtcPeerConnection) {
            rtcPeerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp))
            .then(function () {
                // Only create answers in response to offers
                if (data.sdp.type === "offer") {
                    rtcPeerConnection.createAnswer()
                    .then(description => {
                        // Receive description
                        //console.log("onReceiveRtcConnectionDescription, data: ", data);
                        createdDescription(description, data.from);
                    })
                    .catch(function (error) {
                        console.log("An error occured", error)
                    });
                }
            }).catch(function (error) {
                console.log("An error occured", error)
            });
        }
    };

    const onReceiveRtcIceCandidate = function (data) {
        if (data.from === state.localDisplayedName) {
            return;
        }
        let rtcPeerConnection = rtcPeerConnectionFromId[data.from];
        if (rtcPeerConnection) {
            rtcPeerConnection.addIceCandidate(new RTCIceCandidate(data.ice))
            .then(function (x) {
                //console.log("Added ICE 3");
            }).catch(function (error) {
                console.log("An error occured", error)
            });
        }
    };

    const resendAllRtcRequests = function () {
        resendAllRtcRequestsCount += 1;
        console.log("resendAllRtcRequests:", resendAllRtcRequestsCount);
        console.log("BUG, this function is only called if the parts arrive out of order:");
        if (resendAllRtcRequestsCount > 10) {
            console.log("resendAllRtcRequests too high, canceling and resetting count", resendAllRtcRequestsCount);
            resendAllRtcRequestsCount = 0;
            return;
        }
        Object.keys(resolveFromfileName).forEach(function (fileName) {
            prepareSendRtcData(resolveFromfileName[fileName].target, resolveFromfileName[fileName].message);
        });
    };

    const rtcRequest = function (requestObject) {
        return new Promise(function (resolve, reject) {
            const fileName = requestObject.header.fileName;
            resolveFromfileName[fileName] = resolve;
            const message = {
                header: {
                    is: M.REQUEST,
                    method: requestObject.header.method || M.GET,
                    "Content-Type": "",
                    fileName
                },
                body: requestObject.body || ""
            };
            //requestObject has more info in requestObject.header we could Object.assign to get it all
            resolveFromfileName[fileName].message = message; // resendAllRtcRequests
            resolveFromfileName[fileName].target = state.selectedUserId;
            prepareSendRtcData(state.selectedUserId, message);
        });
    };

    const isOpenFromDataChannel = function (dataChannel) {
        return "open" === dataChannel.readyState;
    };

    const isOpenFromDisplayName = function (id) {
        return isOpenFromDataChannel(rtcSendDataChannelFromId.get(id));
    };

    const userIdChange = function (oldId, newId) {
        if (rtcPeerConnectionFromId[oldId]) {
            const rtcSendDataChannel = rtcPeerConnectionFromId[oldId];
            const sendChannelStateChangeHandler = sendChannelStateChange(newId);

            rtcSendDataChannel.onopen = sendChannelStateChangeHandler;
            rtcSendDataChannel.onclose = sendChannelStateChangeHandler;
            rtcPeerConnectionFromId.set(newId, rtcPeerConnectionFromId[oldId]);
            rtcPeerConnectionFromId.delete(oldId);
            //rtcSendDataChannelFromId uses rtcPeerConnectionFromId so it is also updated
        }
    };

    Object.assign(API, {
        useHandleRequestCustom,
        sendRtcMessage,
        startConnectionWith,
        rtcRequest,
        onReceiveRtcConnectionDescription,
        onReceiveRtcIceCandidate,
        rtcPeerConnectionFromId,
        isOpenFromDisplayName,
        userIdChange
    });

    return API;
}());

'use strict'

importScripts('https://cdn.socket.io/socket.io-1.1.0.js')

let events = {}
let port, socket, roomName, namespace, users, me, locations, volumes, dimensions, screen, distances

let easyrtcids = new Map()

let translate = {x: 0, y: 0}

function ready (p) {
  port = p

  port.onmessage = handleMessage
  port.onerror = handleError

  on('room-name', handleRoomName)
}

function handleRoomName (roomName) {
  roomName = roomName
  namespace = '/' + roomName
  socket = io(namespace)
  initialize()
}

function initialize () {
  on('me', announceMe)
  on('trash-me', trashMe)
  on('my-delta', announceLocation)
  on('my-volume', announceVolume)
  on('my-announcement', announceAnnouncement)
  on('my-response', announceResponse)
  on('request-announcement', requestAnnouncement)

  on('screen', receiveScreen)

  socket.on('connect', handleUsers)
  socket.on('users', handleUsers)
  socket.on('locations', handleLocations)
  socket.on('volumes', handleVolumes)
  socket.on('dimensions', handleDimensions)
  socket.on('announcement', handleAnnouncement)
  socket.on('distances', handleDistances)
}

function on(event, fn) {
  if (!events[event]) {
    events[event] = []
  }
  events[event].push(fn)
}

function off(event, fn) {
  events[event] = events[event].filter(f => f != fn)
}

function handleMessage (msg) {
  if (!msg.data.event) {
    handleError(`Worker posted message without event descriptor: ${msg.data}`)
  }

  if (events[msg.data.event]) {
    events[msg.data.event].forEach(fn => {
      fn(msg.data.data)
    })
  }
}

function handleError (err) {
  emit('error', JSON.stringify(err))
}

function emit (event, data) {
  port.postMessage({event, data})
}

function handleUsers (data) {
  const map = new Map(data)
  if (data) {
    users = map
    emit('users', [...users])
  }

  map.forEach((user, uid) => {
    easyrtcids.set(uid, user.easyrtcid)
  })
}

function announceMe (newme) {
  me = newme
  socket.emit('me', me)
}

function trashMe () {
  me = null
  socket.emit('trash-me')
}

function constrain (x, min, max) {
  return Math.min(Math.max(x, min), max)
}

function announceLocation (data) {
  const {dx, dy} = data
  const base = locations.get(me.id)
  if (!base.x) base.x = 0
  if (!base.y) base.y = 0
  const x = constrain(base.x + dx, 0, dimensions.x)
  const y = constrain(base.y + dy, 0, dimensions.y)

  socket.emit('my-location', {x, y})
}

function announceAnnouncement (msg) {
  msg.author = me.id
  msg.authorAvatar = me.avatar
  msg.authorName = me.name
  socket.emit('my-announcement', msg)
}

function announceResponse (data) {
  if (!me) return handleError('Cannot announce response - me is not defined')

  const {announcement, type, reason, date} = data
  const user = me.id
  const userAvatar = me.avatar
  const userName = me.name
  announcement.responses[type].push({user, reason, date, userAvatar, userName})
  socket.emit('my-announcement', announcement)
}

function requestAnnouncement () {
  socket.emit('request-announcement')
}

function announceVolume (vol) {
  socket.emit('my-volume', vol)
}

function handleLocations (data) {
  if (!me) return null

  locations = new Map(data)
  locations.forEach((value, uid) => {
    emit(`location-${uid}`, value)
  })

  const myLocation = locations.get(me.id)
  if (isInFourth(myLocation)) {
    translate = calcTranslate(myLocation)
    emit('translate', translate)
  }
}

function handleVolumes (data) {
  volumes = new Map(data)
  volumes.forEach((value, uid) => {
    emit(`volume-${uid}`, value)
  })
}

function handleDimensions (data) {
  dimensions = data
  emit('dimensions', dimensions)
}

function handleAnnouncement (data) {
  if (data) {
    emit('announcement', data)
  }
}

function handleDistances (data) {
  if (data) {
    let copy = {}
    for (let uid in data)
      copy[easyrtcids.get(uid)] = data[uid]

    distances = copy
    for (let easyrtcid in copy)
      emit(`distance-to-${easyrtcid}`, distances[easyrtcid])
  }
}

function receiveScreen (size) {
  screen = {
    x: size.x,
    y: size.y
  }
}

function calcTranslate (loc) {
  if (loc) {
    const x = (-1) * loc.x + (screen.x / 2) - 25
    const y = (-1) * loc.y + (screen.y / 2) - 25
    return {x, y}
  } else {
    return {x: 0, y: 0}
  }
}

function isInFourth (loc) {
  let display
  let edge = {}
  if (loc) {
    display = {
      x: loc.x + translate.x,
      y: loc.y + translate.y
    }
  } else {
    display = {x: 0, y: 0}
  }

  edge.w = screen.x / 6
  edge.h = screen.y / 6
  if ((display.x < edge.w) || (display.x > (screen.x - edge.w)))
    return true
  if ((display.y < edge.h) || (display.y > (screen.y - edge.h)))
    return true
  return false
}

onconnect = function (e) {
  ready(e.ports[0])
}

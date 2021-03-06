const debug = require('debug')
const crypto = require('crypto')
const redis = require('../redis')
const colors = require('./colors')
const calcDimensions = require('./calc-dimensions')
const monk = require('monk')
const db = monk(process.env.MONGODB_URI || 'localhost:27017/assemble')
const emails = db.get('emails')
const { print } = require('../utils')

const UPDATE_FREQUENCY = 200

const kue = require('kue')
const queue = kue.createQueue({
  redis: process.env.REDIS_URL
})

const transformId = raw => raw.split('#')[1]

const randInt = (lower, upper) =>
  Math.floor(Math.random() * (upper - lower)) + lower

const ignore = _ => _
const panic = err => {
  throw print(err)
}

const hashObj = obj =>
  crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex')

module.exports = (io, nsp, name) => {
  const room = redis.room(name)
  const pings = {}
  const log = debug('assemble:' + name)
  let updateIntervalId = null

  redis.rooms
    .add(name)
    .then(() => log('Room %s created', name))
    .catch(err => log('Could not create %s: %j', name, err))

  log('Binding events')

  nsp.on('connection', socket => {
    const uid = transformId(socket.id)
    log('New connection - %s', uid)

    socket.on('me', user => {
      room.users
        .add(
          uid,
          Object.assign(user, {
            id: uid,
            color: colors.user[randInt(0, colors.user.length)]
          })
        )
        .then(room.users.getAll)
        .then(allUsers => {
          log('Have users %j', allUsers.map(u => u.id))
          if (allUsers.length > 0 && !updateIntervalId)
            updateIntervalId = setInterval(nsp.update, UPDATE_FREQUENCY)

          nsp.emit('users', allUsers)
          nsp.emit('dimensions', calcDimensions(allUsers.length))

          room.locations
            .get(uid)
            .then(
              loc =>
                loc == null
                  ? room.locations.set(
                      uid,
                      calcDimensions(allUsers.length).map(d => d / 2)
                    )
                  : Promise.resolve(null)
            )
            .then(() =>
              queue.create('location-change', { room: name, uid: uid }).save()
            )
            .catch(panic)
        })
        .catch(panic)

      pings[uid] = 50
      emails
        .update({ email: user.email }, { email: user.email }, { upsert: true })
        .then(obj => {
          log('Saved email %s', user.email)
        })
        .catch(err => {
          log('Could not save email %s – error: %j', user.email, err)
          log(err)
        })
    })

    /*
     * Location, volume updates
     */
    socket.on('location', loc => {
      room.locations.set(uid, loc).then(ignore).catch(panic)
      queue.create('location-change', { room: name, uid: uid }).save()
    })

    socket.on('volume', vol => {
      room.volumes.set(uid, vol).then(ignore).catch(panic)
    })

    /*
     * Checkpoint – new, edit, move, destroy
     */
    socket.on('checkpoint-new', checkpoint =>
      room.checkpoints
        .add(
          hashObj(checkpoint),
          Object.assign(checkpoint, {
            color: colors.checkpoints[randInt(0, colors.checkpoints.length)]
          })
        )
        .then(created =>
          room.checkpoints
            .getAll()
            .then(all => {
              log('Requested add checkpoint %j', checkpoint)
              log('Have checkpoints %j', all)

              queue
                .create('checkpoint-change', { room: name, cid: created.id })
                .save()

              nsp.emit('checkpoints', all)
            })
            .catch(panic)
        )
        .catch(panic)
    )

    socket.on('checkpoint-edit', checkpoint =>
      room.checkpoints
        .set(checkpoint.id, checkpoint)
        .then(() =>
          room.checkpoints
            .getAll()
            .then(all => {
              log('Have checkpoints %j', all)
              queue
                .create('checkpoint-change', { room: name, cid: checkpoint.id })
                .save()
              nsp.emit('checkpoints', all)
            })
            .catch(panic)
        )
        .catch(panic)
    )

    socket.on('checkpoint-move', ({ id, loc }) =>
      room.checkpoints.moveTo(id, loc).then(() =>
        room.checkpoints
          .getAll()
          .then(all => {
            log('Have checkpoints %j', all)
            queue.create('checkpoint-change', { room: name, cid: id }).save()
            nsp.emit('checkpoints', all)
          })
          .catch(panic)
      )
    )

    socket.on('checkpoint-destroy', id =>
      room.checkpoints
        .remove(id)
        .then(() => {
          log('Check %s is gone', id)

          room.checkpoints
            .getAll()
            .then(all => {
              nsp.emit('checkpoints', all)
            })
            .catch(panic)
        })
        .catch(panic)
    )

    socket.on('signal', config => {
      const fromUid = uid
      const sid = `/${name}#${config.to}`

      if (nsp.connected[sid]) {
        nsp.connected[sid].emit(`signal-from-${fromUid}`, config.data)
      }
    })

    /*
     * Broadcasting, bandiwdth, etc
     */

    const configureBroadcast = name => {
      queue
        .create('broadcast-on', { room: name })
        .on('complete', ({ heap, broadcaster }) => {
          if (!heap || !broadcaster) return null

          // Recursive function to navigate the heap and send each users
          // position in the tree to them
          log('Broadcast heap: %j', heap)

          // didn't know what to call it so i called it _
          const _ = (parent, current, heap) => {
            const sid = `/${name}#${current}`
            const children = Object.keys(heap[current])

            log('Emitting to %s, %j', sid, {
              toRelay: {
                original: broadcaster,
                immediate: parent || broadcaster
              },
              relayingTo: children
            })

            nsp.connected[sid].emit('switchboard', {
              toRelay: {
                original: broadcaster,
                immediate: parent || broadcaster
              },
              relayingTo: children
            })

            children.forEach(next => _(current, next, heap[current]))
          }

          _(null, broadcaster, heap)
        })
        .on('error', panic)
        .save()
    }

    socket.on('broadcast-on', user => {
      room.broadcasting
        .set(user)
        .then(ok => nsp.emit('broadcasting', user))
        .then(ok => configureBroadcast(name))
        .catch(panic)
    })

    socket.on('broadcast-off', () =>
      room.broadcasting
        .clear()
        .then(ok => nsp.emit('broadcasting', false))
        .catch(panic)
    )

    socket.on('my-bandwidth', data => {
      room.conns
        .set(uid, data)
        .then(ok => configureBroadcast(name))
        .catch(panic)
    })

    socket.on('disconnect', () => {
      pings[uid] = undefined
      delete pings[uid]

      room.users
        .remove(uid)
        .then(_ =>
          room.users
            .getAll()
            .then(allUsers => {
              nsp.emit('users', allUsers)

              log('After disconnect have users %j', allUsers)

              if (allUsers.length == 0) {
                setTimeout(() => {
                  room.users
                    .size()
                    .then(num => {
                      if (num == 0) {
                        log('Imploding...')
                        nsp.implode()
                        clearInterval(updateIntervalId)

                        redis.rooms
                          .remove(name)
                          .then(() => log('Successfully removed %s', name))
                          .catch(err =>
                            log('Could not remove %s: %j', name, err)
                          )
                      }
                    })
                    .catch(panic)
                }, 200)
              }

              nsp.emit('dimensions', calcDimensions(allUsers.length))
            })
            .catch(panic)
        )
        .catch(panic)
    })
  })

  nsp.implode = () => {
    nsp.removeAllListeners()
    delete io.nsps['/' + name]
  }

  nsp.update = () => {
    for (let sid in nsp.connected) {
      room.updates
        .for(transformId(sid))
        .then(update => {
          /* Could not be connected if stuff has changed since 5 lines ago */
          if (nsp.connected[sid]) {
            nsp.connected[sid].emit('update', update)
          }
        })
        .catch(panic)
    }
  }

  queue.process(`update-${name}`, (job, done) => {
    const { event, data } = job.data
    log('Emitting %s: %j', event, data)

    for (let sid in nsp.connected) {
      log(Date.now())
      nsp.connected[sid].emit(event, data)
    }

    done()
  })

  return nsp
}

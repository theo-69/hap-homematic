// this is just a template
const path = require('path')
const HomeMaticAccessory = require(path.join(__dirname, 'HomeMaticAccessory.js'))

class HomeMaticBlindAccessory extends HomeMaticAccessory {
  publishServices (Service, Characteristic) {
    let self = this
    var blind = this.getService(Service.WindowCovering)
    this.delayOnSet = 750
    this.observeInhibit = false // make this configurable
    this.inhibit = false
    this.minValueForClose = 0
    this.maxValueForOpen = 100
    this.ignoreWorking = true
    this.currentLevel = 0
    this.targetLevel = undefined
    this.isWorking = false

    this.currentPos = blind.getCharacteristic(Characteristic.CurrentPosition)
      .on('get', (callback) => {
        self.getValue('LEVEL', true).then(value => {
          value = self.processBlindLevel(value)
          self.log.debug('[BLIND] getCurrent Position %s', value)
          if (callback) callback(null, value)
        })
      })

    this.currentPos.eventEnabled = true

    this.targetPos = blind.getCharacteristic(Characteristic.TargetPosition)
      .on('get', (callback) => {
        self.getValue('LEVEL', true).then(value => {
          value = self.processBlindLevel(value)
          if (callback) {
            self.log.debug('[BLIND] return %s as TargetPosition', value)
            callback(null, value)
          }
        })
      })
      .on('set', (value, callback) => {
      // if obstruction has been detected
        if ((self.observeInhibit === true) && (self.inhibit === true)) {
        // wait one second to resync data
          self.log.debug('[BLIND] inhibit is true wait to resync')
          clearTimeout(self.timer)
          self.timer = setTimeout(() => {
            self.queryData()
          }, 1000)
        } else {
          self.targetLevel = value
          self.eventupdate = false // whaat?
          self.setValueDelayed('LEVEL', (parseFloat(value) / 100), self.delayOnSet)
        }
        callback()
      })

    this.pstate = blind.getCharacteristic(Characteristic.PositionState)
      .on('get', (callback) => {
        self.getValue('DIRECTION', true).then(value => {
          if (callback) {
            var result = 2
            if (value !== undefined) {
              switch (value) {
                case 0:
                  result = 2 // Characteristic.PositionState.STOPPED
                  break
                case 1:
                  result = 0 // Characteristic.PositionState.DECREASING
                  break
                case 2:
                  result = 1 // Characteristic.PositionState.INCREASING
                  break
                case 3:
                  result = 2 // Characteristic.PositionState.STOPPED
                  break
              }
              callback(null, result)
            } else {
              callback(null, '0')
            }
          }
        })
      })

    // this.pstate.eventEnabled = true

    if (this.observeInhibit === true) {
      this.obstruction = blind.getCharacteristic(Characteristic.ObstructionDetected)
        .on('get', (callback) => {
          callback(null, this.inhibit)
        })
      this.obstruction.eventEnabled = true
      this.registeraddressForEventProcessingAtAccessory(this.buildAddress('INHIBIT'), function (newValue) {
        self.log.debug('[BLIND] set Obstructions to %s', newValue)
        self.inhibit = self.isTrue(newValue)
        if (self.obstruction !== undefined) {
          self.obstruction.updateValue(self.isTrue(newValue), null)
        }
      })
    }

    this.registeraddressForEventProcessingAtAccessory(this.buildAddress('DIRECTION'), function (newValue) {
      self.updatePosition(parseInt(newValue))
    })

    this.registeraddressForEventProcessingAtAccessory(this.buildAddress('LEVEL'), function (newValue) {
      if (self.isWorking === false) {
        self.log.debug('[BLIND] set final HomeKitValue to %s', newValue)
        self.setFinalBlindLevel(newValue)
      } else {
        let lvl = self.processBlindLevel(newValue)
        self.log.debug('[BLIND] set HomeKitValue to %s', lvl)
        self.currentLevel = lvl
        self.currentPos.updateValue(self.currentLevel, null)
      }
    })

    this.registeraddressForEventProcessingAtAccessory(this.buildAddress('WORKING'), function (newValue) {
    // Working false will trigger a new remote query
      if (!self.isTrue(newValue)) {
        self.isWorking = false
        self.getValue('LEVEL', true)
      } else {
        self.isWorking = true
      }
    })

    this.queryData()
  }

  queryData (value) {
    // trigger new event (datapointEvent)
    // kill the cache first
    let self = this
    this.getValue('LEVEL', true).then(value => {
      value = self.processBlindLevel(value)
      self.currentPos.updateValue(value, null)
      self.targetPos.updateValue(value, null)
      self.targetLevel = undefined
    })

    if (this.observeInhibit === true) {
      this.getValue('INHIBIT', true).then(value => {
        self.updateObstruction(self.isTrue(value)) // not sure why value (true/false) is currently a string? - but lets convert it if it is
      })
    }
  }

  processBlindLevel (newValue) {
    var value = parseFloat(newValue)
    value = value * 100
    if (value < this.minValueForClose) {
      value = 0
    }
    if (value > this.maxValueForOpen) {
      value = 100
    }
    this.log.debug('[BLIND] processLevel (%s) min (%s) max (%s) r (%s)', newValue, this.minValueForClose, this.maxValueForOpen, value)
    return value
  }

  // https://github.com/thkl/homebridge-homematic/issues/208
  // if there is a custom close level and the real level is below homekit will get the 0% ... and visevera for max level

  setFinalBlindLevel (value) {
    value = this.processBlindLevel(value)
    this.currentPos.updateValue(value, null)
    this.targetPos.updateValue(value, null)
    this.targetLevel = undefined
    this.pstate.updateValue(2, null) // STOPPED
  }

  updatePosition (value) {
    // 0 = NONE (Standard)
    // 1=UP
    // 2=DOWN
    // 3=UNDEFINED
    switch (value) {
      case 0:
        this.pstate.updateValue(2, null)
        break
      case 1: // opening - INCREASING
        this.pstate.updateValue(1, null)
        // set target position to maximum, since we don't know when it stops
        this.guessTargetPosition(100)
        break
      case 2: // closing - DECREASING
        this.pstate.updateValue(0, null)
        // same for closing
        this.guessTargetPosition(0)
        break
      case 3:
        this.pstate.updateValue(2, null)
        break
    }
  }

  guessTargetPosition (value) {
    // Only update Target position if it has not been set via homekit (see targetPos.on('set'))
    if (this.targetLevel === undefined) {
      this.targetPos.updateValue(value, null)
    }
  }

  updateObstruction (value) {
    this.inhibit = value
    this.obstruction.updateValue(value, null)
  }

  shutdown () {
    this.log.debug('[BLIND] shutdown')
    super.shutdown()
    clearTimeout(this.timer)
  }
}
module.exports = HomeMaticBlindAccessory
module.exports = {
  tmpNameSync() {
    throw new Error("temporary files are not available in a Worker")
  },
}

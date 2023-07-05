import { ContentScript } from 'cozy-clisk/dist/contentscript'
import { format } from 'date-fns'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('bouyguestelecomCCC')

const baseUrl = 'https://bouyguestelecom.fr'
const monCompteUrl = 'https://www.bouyguestelecom.fr/mon-compte'
const dashboardUrl = `${monCompteUrl}/dashboard`
const apiUrl = 'https://api.bouyguestelecom.fr'

let billsJSON = []
// Stocker la référence à la fonction d'origine fetch
const fetchOriginal = window.fetch

// Remplacer la fonction fetch par une nouvelle fonction
window.fetch = async (...args) => {
  const response = await fetchOriginal(...args)
  if (typeof args[0] === 'string' && args[0].includes('/graphql')) {
    await response
      .clone()
      .json()
      .then(body => {
        billsJSON.push(body)
        return response
      })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.log(err)
        return response
      })
  }
  return response
}

class BouyguesTelecomContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', 'navigateToLoginForm starts')
    await this.goto(baseUrl)
    await this.waitForElementInWorker('#login')
    await this.waitForElementInWorker('#menu')
    await this.clickAndWait('#login', '#bytelid_partial_acoMenu_login')
  }

  async ensureAuthenticated(account) {
    this.log('info', 'EnsureAuthenticated starts')
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.navigateToLoginForm()
    if (await this.runInWorker('checkAuthenticated')) {
      this.log('info', 'Auth detected')
      return true
    }
    this.log('info', 'No auth detected')
    // let credentials = await this.getCredentials()
    // if (credentials && credentials.email && credentials.password) {
    //   try {
    //     this.log('info', 'Got credentials, trying autologin')
    //     await this.tryAutoLogin(credentials)
    //   } catch (error) {
    //     this.log('warn', 'autoLogin error' + error.message)
    //     await this.showLoginFormAndWaitForAuthentication()
    //   }
    // } else {
    //   this.log('info', 'No credentials found, waiting for user input')
    //   await this.showLoginFormAndWaitForAuthentication()
    // }
    this.log('info', 'No credentials found, waiting for user input')
    await this.showLoginFormAndWaitForAuthentication()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', 'ensureNotAuthenticated starts')
    await this.navigateToMonComptePage()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      return true
    }
    const isPresent = await this.isElementInWorker('#notifications')
    if (isPresent) {
      await this.clickAndWait('#menu', '.navbar-dropdown-section')
      await this.evaluateInWorker(() => {
        document.querySelectorAll('a[class="navbar-item"]')[2].click()
      })
      await this.waitForElementInWorker('#menu')
    }
  }

  async checkAuthenticated() {
    this.log('info', 'checkAuthenticated starts')
    const passwordField = document.querySelector('#password')
    const loginField = document.querySelector('#username')
    if (passwordField && loginField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('info', "Sending user's credentials to Pilot")
      this.sendToPilot({
        userCredentials
      })
    }
    if (
      document.location.href === dashboardUrl &&
      document.querySelector('#notifications')
    ) {
      this.log('info', 'Auth check succeeded')
      return true
    }
    return false
  }

  async findAndSendCredentials(loginField, passwordField) {
    this.log('info', 'findAndSendCredentials starts')
    let userLogin = loginField.value
    let userPassword = passwordField.value
    const userCredentials = {
      email: userLogin,
      password: userPassword
    }
    return userCredentials
  }

  async showLoginFormAndWaitForAuthentication() {
    this.log('info', 'showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', 'getUserDataFromWebsite starts')
    await this.navigateToInfosPage()
    await this.runInWorker('fetchIdentity')
    await this.saveIdentity(this.store.userIdentity)
    return {
      sourceAccountIdentifier: this.store.userIdentity.email
        ? this.store.userIdentity.email
        : 'defaultTemplateSourceAccountIdentifier'
    }
  }

  async fetch(context) {
    this.log('info', 'fetch starts')
    const moreBillsButtonSelector =
      '#page > section > .container > .has-text-centered > a'
    await this.navigateToBillsPage()
    await this.waitForElementInWorker('div[class="box is-loaded"]')
    await this.runInWorkerUntilTrue({
      method: 'checkInterception',
      args: [1]
    })

    let moreBills = true
    let lap = 0
    while (moreBills) {
      lap++
      moreBills = await this.isElementInWorker(moreBillsButtonSelector)
      if (moreBills) {
        await this.runInWorker('click', moreBillsButtonSelector)
        await this.runInWorkerUntilTrue({
          method: 'checkInterception',
          args: [lap + 1]
        })
      }
    }
    const neededIndex = this.store.arrayLength - 1
    const pageBills = await this.runInWorker('computeBills', {
      lap,
      neededIndex
    })
    for (const oneBill of pageBills) {
      const billToDownload = await this.runInWorker('getDownloadHref', oneBill)
      if (
        billToDownload.lineNumber.startsWith('06') ||
        billToDownload.lineNumber.startsWith('07')
      ) {
        await this.saveBills([billToDownload], {
          context,
          fileIdAttributes: ['vendorRef'],
          contentType: 'application/pdf',
          qualificationLabel: 'phone_invoice',
          subPath: `${billToDownload.lineNumber}`
        })
      } else {
        await this.saveBills([billToDownload], {
          context,
          fileIdAttributes: ['vendorRef'],
          contentType: 'application/pdf',
          qualificationLabel: 'isp_invoice',
          subPath: `${billToDownload.lineNumber}`
        })
      }
    }
  }

  async navigateToInfosPage() {
    this.log('info', 'navigateToInfosPage starts')
    await this.waitForElementInWorker('div[href="/mon-compte/infosperso"] a')
    await this.clickAndWait(
      'div[href="/mon-compte/infosperso"] a',
      '.personalInfosAccountDetails'
    )
  }

  async navigateToBillsPage() {
    this.log('info', 'navigateToBillsPage starts')
    await this.clickAndWait('#menu', '.has-ending-arrow')
    await this.evaluateInWorker(() => {
      document.querySelectorAll('.has-ending-arrow')[1].click()
    })
    await this.waitForElementInWorker('#page > section > .container')
  }

  async navigateToMonComptePage() {
    await this.goto(monCompteUrl)
    await Promise.race([
      this.waitForElementInWorker('#casiframe'),
      this.waitForElementInWorker('#notifications')
    ])
  }

  async fetchIdentity() {
    this.log('info', 'fetchIdentity starts')
    let mailAddress
    let phoneNumber
    const infosElements = document.querySelectorAll(
      '.personalInfosAccountDetails .tiles .segment:not(.flexCenter)'
    )
    const elementsArray = Array.from(infosElements)
    const infosArray = []
    for (const info of elementsArray) {
      const spans = info.querySelectorAll('span')
      if (
        spans[0].textContent.includes('Email') ||
        spans[0].textContent.includes('Numéro')
      ) {
        // Here we select index 1 because index 0 is the section's name
        const spanInfo = spans[1].textContent
        infosArray.push(spanInfo)
      }
      continue
    }
    mailAddress = infosArray[0]
    phoneNumber = infosArray[1].replace(/ /g, '')
    const firstName = document.querySelector('.firstName').textContent
    const familyName = document.querySelector('.name').textContent
    const addressElement = document.querySelector(
      '.personalInfosBillingAddress .ui .is360 .text div[class="ui is360 text"] > span'
    ).innerHTML
    const [street, postCodeAndCity, country] = addressElement.split('<br>')
    const [postCode, city] = postCodeAndCity.split(' ')
    const userIdentity = {
      email: mailAddress,
      phone: [
        {
          type: phoneNumber.startsWith('06' || '07') ? 'mobile' : 'home',
          number: phoneNumber
        }
      ],
      name: {
        givenName: firstName,
        familyName
      },
      address: {
        street,
        postCode,
        city,
        country,
        formattedAddress: addressElement.replace(/<br>/g, ' ')
      }
    }
    await this.sendToPilot({ userIdentity })
    this.log('info', `${JSON.stringify(userIdentity)}`)
  }

  async checkInterception(number) {
    this.log('info', 'checkInterception starts')
    this.log('info', `number in checkInterception : ${number}`)
    if (billsJSON.length >= number) {
      await this.sendToPilot({ arrayLength: billsJSON.length })
      return true
    }
    return false
  }

  async computeBills(infos) {
    this.log('info', 'computeBills starts')
    const computedBills = []
    let comptesFacturation =
      billsJSON[infos.neededIndex].data.consulterPersonne.factures
        .comptesFacturation

    let foundBills = []
    for (let i = 0; i < comptesFacturation.length; i++) {
      const billsForOneLine = comptesFacturation[i].factures
      billsForOneLine.forEach(bill => {
        foundBills.push(bill)
      })
    }

    for (const foundBill of foundBills) {
      const fileHref = foundBill.facturePDF[0].href
      const amount = foundBill.mntTotFacture
      const foundDate = foundBill.dateFacturation
      const vendor = 'Bouygues Telecom'
      const date = new Date(foundDate)
      const formattedDate = format(date, 'yyyy-MM-dd')
      const currency = '€'
      const lineNumber = foundBill.lignes[0].numeroLigne
      let computedBill = {
        lineNumber,
        amount,
        currency,
        filename: `${formattedDate}_${vendor}_${amount}${currency}.pdf`,
        fileurl: `${apiUrl}${fileHref}`,
        date,
        vendor: 'Bouygues Telecom',
        vendorRef: foundBill.id,
        fileAttributes: {
          metadata: {
            contentAuthor: 'bouyguestelecom.fr',
            datetime: date,
            datetimeLabel: 'issueDate',
            isSubscription: true,
            issueDate: new Date(),
            cabonCopy: true
          }
        }
      }
      computedBills.push(computedBill)
    }
    return computedBills
  }

  async getDownloadHref(bill) {
    this.log('info', 'getDownloadHref starts')
    const hrefAndToken = await this.getFileDownloadHref(bill.fileurl)
    let goodBill = {
      ...bill
    }
    goodBill.fileurl = `${apiUrl}${hrefAndToken.downloadHref}`
    goodBill.requestOptions = {
      headers: {
        Authorization: `BEARER ${hrefAndToken.token}`
      }
    }
    return goodBill
  }

  async getFileDownloadHref(url) {
    this.log('info', 'getFileDownloadHref starts')
    const token = window.sessionStorage.getItem('a360-access_token')
    const response = await window.fetch(url, {
      headers: {
        Authorization: `BEARER ${token}`
      }
    })
    const data = await response.json()
    const downloadHref = data._actions.telecharger.action
    return { downloadHref, token }
  }
}

const connector = new BouyguesTelecomContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'fetchIdentity',
      'checkInterception',
      'computeBills',
      'getDownloadHref'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

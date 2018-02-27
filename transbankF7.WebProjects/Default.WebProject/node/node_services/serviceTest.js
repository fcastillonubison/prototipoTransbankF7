exports.handler = function(packet,response,sendResponse) {
    
    /*
    	'packet' properties are passed in when this service is called
    	for example, when calling this service from Xbasic:
    	dim p as p
    	p.firstname = "Fred"
    	p.lastname = "Jones"
    	dim flagRestartNode as L = .t. 'If you don't set to .t., edits to the service will not be seen
    	dim flagOpenCommandWindow as L = .f. 'set to true if you want to see output from console.log() commands
    	dim pOut as p
    	pOut = node_request_result("__serviceName__",p,flagRestartNode,flagOpenCommandWindow)
    	'pOut has .error (will be blank if no error) and .result - result of the call
    	
    	
    	'attachments' allows you to send binary data in your response. you can send 
    	an array of binary objects. For example:
    	
	    	var attachments = [
			    {name: 'myImage', mimetype: 'image/png', data: binaryImageData},
			    {name: 'myPDFFile', mimetype: 'application/pdf', data: binaryPDFFile}
			];


	    	response.result = 'Sending some binary data in "attachments"';
    		sendResponse(response,attachments)
    	
    	
    */
    
    var attachments = null;
    var msg = 'Hello ' + packet.firstname + ' ' + packet.lastname;
    response.result = msg;
    console.log(msg);
    sendResponse(response,attachments);
};

